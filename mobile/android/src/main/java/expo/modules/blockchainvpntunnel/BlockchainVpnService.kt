package expo.modules.blockchainvpntunnel

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import com.blockchainvpn.mobile.noisemobile.Noisemobile
import com.blockchainvpn.mobile.noisemobile.Session
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetSocketAddress
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread

/**
 * Android counterpart of protocol/udp/cmd/tun-client. Builds a VpnService
 * TUN, opens a UDP socket protected from its own routing, performs a
 * Noise IK handshake against blockchain-vpn-tun-server, and runs the
 * resulting AEAD-sealed transport between TUN and UDP.
 *
 * Crypto comes from libs/noisemobile.aar — the same Go IK library that
 * the Linux/Windows clients use, exposed via `gomobile bind`. The Kotlin
 * side just owns TUN+socket I/O and the threading; every byte that
 * leaves this device is sealed by ChaCha20-Poly1305 in the Go layer.
 */
class BlockchainVpnService : VpnService() {

  data class Config(
    val serverHost: String,
    val serverPort: Int,
    val tunCidr: String,
    val tunGateway: String,
    val mtu: Int,
    val routeDefault: Boolean,
    val sessionName: String,
    val noiseSeed: ByteArray,
    val serverNoisePub: ByteArray
  ) {
    companion object {
      fun fromIntent(intent: Intent): Config = Config(
        serverHost = intent.getStringExtra("serverHost") ?: "",
        serverPort = intent.getIntExtra("serverPort", 443),
        tunCidr = intent.getStringExtra("tunCidr") ?: "10.99.0.2/24",
        tunGateway = intent.getStringExtra("tunGateway") ?: "10.99.0.1",
        mtu = intent.getIntExtra("mtu", 1380),
        routeDefault = intent.getBooleanExtra("routeDefault", true),
        sessionName = intent.getStringExtra("sessionName") ?: "blockchain-vpn",
        noiseSeed = intent.getByteArrayExtra("noiseSeed") ?: ByteArray(0),
        serverNoisePub = intent.getByteArrayExtra("serverNoisePub") ?: ByteArray(0)
      )
    }
  }

  private var tunFd: ParcelFileDescriptor? = null
  private var udpSocket: DatagramSocket? = null
  private var tunToUdpThread: Thread? = null
  private var udpToTunThread: Thread? = null
  private var noiseSession: Session? = null

  @Volatile private var running = false

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopTunnel()
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      return START_NOT_STICKY
    }

    val config = intent?.let { Config.fromIntent(it) }
    if (config == null) {
      Log.w(TAG, "onStartCommand without config; stopping")
      stopSelf()
      return START_NOT_STICKY
    }

    startInForeground(config.sessionName)
    // startTunnel does a synchronous Noise IK handshake — connect + send +
    // receive on a UDP socket — which Android forbids on the main thread
    // under StrictMode. Run the whole bring-up on a worker thread; flip
    // currentState only after it succeeds. onStartCommand returns
    // immediately so the system doesn't ANR-kill us.
    thread(name = "bvpn-bring-up") {
      try {
        startTunnel(config)
        currentState.set(State.UP)
      } catch (t: Throwable) {
        Log.e(TAG, "startTunnel failed", t)
        lastError.set(t.message ?: t.javaClass.simpleName)
        currentState.set(State.ERROR)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
      }
    }
    return START_STICKY
  }

  override fun onDestroy() {
    stopTunnel()
    currentState.set(State.DOWN)
    super.onDestroy()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    if (currentState.get() == State.UP) {
      Log.i(TAG, "onTaskRemoved: keeping tunnel alive (foreground service)")
      return
    }
    super.onTaskRemoved(rootIntent)
  }

  override fun onRevoke() {
    stopTunnel()
    currentState.set(State.DOWN)
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun startTunnel(config: Config) {
    if (config.noiseSeed.size != 32) {
      throw IllegalArgumentException("noiseSeed must be 32 bytes (got ${config.noiseSeed.size})")
    }
    if (config.serverNoisePub.size != 32) {
      throw IllegalArgumentException("serverNoisePub must be 32 bytes (got ${config.serverNoisePub.size})")
    }

    val (tunIp, tunPrefix) = parseCidr(config.tunCidr)

    val builder = Builder()
      .setSession(config.sessionName)
      .setMtu(config.mtu)
      .addAddress(tunIp, tunPrefix)
      .addDnsServer("1.1.1.1")
      .addDnsServer("8.8.8.8")

    if (config.routeDefault) {
      builder.addRoute("0.0.0.0", 1)
      builder.addRoute("128.0.0.0", 1)
    } else {
      builder.addRoute("0.0.0.0", 0)
    }

    val pfd = builder.establish() ?: throw IllegalStateException("VpnService.Builder.establish() returned null")
    tunFd = pfd

    val socket = DatagramSocket()
    if (!protect(socket)) {
      throw IllegalStateException("VpnService.protect() refused the UDP socket")
    }
    socket.connect(InetSocketAddress(config.serverHost, config.serverPort))
    socket.soTimeout = 5_000
    udpSocket = socket

    // --- Noise IK handshake ----------------------------------------------
    val session = Noisemobile.newInitiator(config.noiseSeed, config.serverNoisePub, PROLOGUE)
    val msgA = session.writeHandshakeA(ByteArray(0))
    socket.send(DatagramPacket(msgA, msgA.size))

    val handshakeBuf = ByteArray(BUF_SIZE)
    val handshakePkt = DatagramPacket(handshakeBuf, handshakeBuf.size)
    socket.receive(handshakePkt)
    val msgB = handshakeBuf.copyOf(handshakePkt.length)
    session.readHandshakeB(msgB)
    if (!session.handshakeComplete()) {
      throw IllegalStateException("noise handshake didn't complete after msg B")
    }
    noiseSession = session
    Log.i(TAG, "noise handshake complete with ${config.serverHost}:${config.serverPort}")
    // Restore the "block forever" semantics for the steady-state loop.
    socket.soTimeout = 0
    running = true

    val inStream = FileInputStream(pfd.fileDescriptor)
    val outStream = FileOutputStream(pfd.fileDescriptor)

    Log.i(TAG, "tunnel up: tun=${config.tunCidr} server=${config.serverHost}:${config.serverPort} mtu=${config.mtu} routeDefault=${config.routeDefault}")

    tunToUdpThread = thread(name = "bvpn-tun-to-udp") {
      val buf = ByteArray(BUF_SIZE)
      var pkts = 0L
      var bytes = 0L
      var lastReport = System.currentTimeMillis()
      try {
        while (running) {
          val n = inStream.read(buf)
          if (n <= 0) continue
          pkts++
          bytes += n
          val plain = if (n == buf.size) buf else buf.copyOf(n)
          try {
            val wire = session.encryptTransport(plain)
            socket.send(DatagramPacket(wire, wire.size))
          } catch (t: Throwable) {
            if (running) Log.w(TAG, "encrypt/send: ${t.message}")
          }
          val now = System.currentTimeMillis()
          if (now - lastReport >= 10_000) {
            Log.i(TAG, "tun->udp stats: pkts=$pkts bytes=$bytes")
            lastReport = now
          }
        }
      } catch (t: Throwable) {
        if (running) Log.e(TAG, "tun-to-udp loop", t)
      } finally {
        running = false
        Log.i(TAG, "tun-to-udp exited: pkts=$pkts bytes=$bytes")
      }
    }

    udpToTunThread = thread(name = "bvpn-udp-to-tun") {
      val buf = ByteArray(BUF_SIZE)
      val packet = DatagramPacket(buf, buf.size)
      var pkts = 0L
      var bytes = 0L
      var drops = 0L
      var lastReport = System.currentTimeMillis()
      try {
        while (running) {
          try {
            socket.receive(packet)
            val wire = if (packet.length == buf.size) buf else buf.copyOf(packet.length)
            val plain = try {
              session.decryptTransport(wire)
            } catch (t: Throwable) {
              drops++
              if (drops <= 5) {
                Log.w(TAG, "decrypt drop #$drops: ${t.message}")
              }
              continue
            }
            pkts++
            bytes += plain.size
            outStream.write(plain, 0, plain.size)
          } catch (t: Throwable) {
            if (running) Log.w(TAG, "udp recv: ${t.message}")
          }
          val now = System.currentTimeMillis()
          if (now - lastReport >= 10_000) {
            Log.i(TAG, "udp->tun stats: pkts=$pkts bytes=$bytes drops=$drops")
            lastReport = now
          }
        }
      } catch (t: Throwable) {
        if (running) Log.e(TAG, "udp-to-tun loop", t)
      } finally {
        running = false
        Log.i(TAG, "udp-to-tun exited: pkts=$pkts bytes=$bytes drops=$drops")
      }
    }
  }

  private fun stopTunnel() {
    running = false
    try { udpSocket?.close() } catch (_: Throwable) {}
    try { tunFd?.close() } catch (_: Throwable) {}
    udpSocket = null
    tunFd = null
    tunToUdpThread = null
    udpToTunThread = null
    noiseSession = null
  }

  private fun startInForeground(sessionName: String) {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "Blockchain VPN",
        NotificationManager.IMPORTANCE_LOW
      )
      nm.createNotificationChannel(channel)
    }

    val pi = PendingIntent.getActivity(
      this,
      0,
      packageManager.getLaunchIntentForPackage(packageName) ?: Intent(),
      PendingIntent.FLAG_IMMUTABLE
    )

    val notification: Notification = Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("Blockchain VPN")
      .setContentText("Tunnel active: $sessionName")
      .setSmallIcon(android.R.drawable.ic_lock_lock)
      .setContentIntent(pi)
      .setOngoing(true)
      .build()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(
        NOTIFICATION_ID,
        notification,
        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
      )
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun parseCidr(cidr: String): Pair<String, Int> {
    val parts = cidr.split('/')
    require(parts.size == 2) { "invalid CIDR: $cidr" }
    return parts[0] to parts[1].toInt()
  }

  companion object {
    private const val TAG = "BlockchainVpnService"
    private const val CHANNEL_ID = "blockchain-vpn"
    private const val NOTIFICATION_ID = 7001
    private const val BUF_SIZE = 64 * 1024
    private val PROLOGUE = "blockchain-vpn-v1".toByteArray(Charsets.UTF_8)

    const val ACTION_START = "expo.modules.blockchainvpntunnel.START"
    const val ACTION_STOP = "expo.modules.blockchainvpntunnel.STOP"

    /** Snapshot state used by the Expo module's status() handler. */
    enum class State { DOWN, UP, ERROR }
    val currentState = AtomicReference(State.DOWN)
    val lastError = AtomicReference<String?>(null)

    fun startIntent(context: Context, config: Config): Intent =
      Intent(context, BlockchainVpnService::class.java).apply {
        action = ACTION_START
        putExtra("serverHost", config.serverHost)
        putExtra("serverPort", config.serverPort)
        putExtra("tunCidr", config.tunCidr)
        putExtra("tunGateway", config.tunGateway)
        putExtra("mtu", config.mtu)
        putExtra("routeDefault", config.routeDefault)
        putExtra("sessionName", config.sessionName)
        putExtra("noiseSeed", config.noiseSeed)
        putExtra("serverNoisePub", config.serverNoisePub)
      }

    fun stopIntent(context: Context): Intent =
      Intent(context, BlockchainVpnService::class.java).apply {
        action = ACTION_STOP
      }
  }
}
