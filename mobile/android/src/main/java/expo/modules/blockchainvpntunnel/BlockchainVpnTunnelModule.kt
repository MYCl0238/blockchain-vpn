package expo.modules.blockchainvpntunnel

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.VpnService
import com.blockchainvpn.mobile.noisemobile.Noisemobile
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicReference

/**
 * Implements the JS surface defined in docs/CLIENT_CONTROL_API.md for Android.
 * Lifecycle: up() asks for VpnService permission (interactive prepare()),
 * obtains a tunnel lease from the control plane, and starts
 * [BlockchainVpnService]. down() stops it. status() reads
 * [BlockchainVpnService.currentState] without round-tripping through the
 * service.
 */
class BlockchainVpnTunnelModule : Module() {

  data class ClientConfig(
    var serverHost: String = "84.21.171.106",
    var serverPort: Int = 443,
    var controlBaseUrl: String = "https://84.21.171.106/vpn-api",
    var controlToken: String = "",
    var clientId: String = "",
    var mtu: Int = 1380,
    var routeDefault: Boolean = true,
    // Noise IK identity. noiseSeed is the 32-byte X25519 private scalar
    // derived from the wallet signature (see /api/wallet/noise-identity
    // on the webui); serverNoisePub is the 32-byte server static pubkey
    // pinned from /api/vpn/config. Both must be set before up() can run.
    var noiseSeed: ByteArray = ByteArray(0),
    var serverNoisePub: ByteArray = ByteArray(0),
    var walletAddress: String = ""
  )

  private val config = ClientConfig()
  private val pendingPermission = AtomicReference<Promise?>(null)
  private val ioScope = CoroutineScope(Dispatchers.IO)

  // On-disk noise binding (private key + metadata). The keystore lives
  // under the app's internal storage so it survives process restarts and
  // is wiped on app-data clear. Format mirrors the desktop daemon:
  //   <ctx.filesDir>/noise/static.key       — raw 32 bytes, mode 0600
  //   <ctx.filesDir>/noise/binding.json     — wallet + pub + endpoint
  private fun noiseDir(ctx: Context): File = File(ctx.filesDir, "noise").apply { mkdirs() }
  private fun noiseKeyFile(ctx: Context): File = File(noiseDir(ctx), "static.key")
  private fun noiseBindingFile(ctx: Context): File = File(noiseDir(ctx), "binding.json")

  override fun definition() = ModuleDefinition {
    Name("BlockchainVpnTunnel")

    OnCreate {
      // Pick up override values from BuildConfig if the host app set them.
      tryLoadBuildConfig()?.let { merge(it) }
      // Load any persisted noise binding so the tunnel can come up without
      // forcing the user to re-pair after each app restart.
      appContext.reactContext?.let { loadPersistedNoiseBinding(it) }
    }

    AsyncFunction("configure") { input: Map<String, Any?> ->
      input["serverHost"]?.let { config.serverHost = it.toString() }
      input["serverPort"]?.let { config.serverPort = (it as Number).toInt() }
      input["controlBaseUrl"]?.let { config.controlBaseUrl = it.toString() }
      input["controlToken"]?.let { config.controlToken = it.toString() }
      input["clientId"]?.let { config.clientId = it.toString() }
      input["mtu"]?.let { config.mtu = (it as Number).toInt() }
      input["routeDefault"]?.let { config.routeDefault = it as Boolean }
      okResult("config", "configured", "config updated")
    }

    AsyncFunction("getNoiseStatus") { ->
      val bound = config.noiseSeed.size == 32 && config.serverNoisePub.size == 32
      val pub = if (bound) tryHex(Noisemobile.publicKeyHex(config.noiseSeed)) else null
      mapOf(
        "bound" to bound,
        "walletAddress" to config.walletAddress.ifEmpty { null },
        "clientPublicKey" to pub,
        "serverPublicKey" to if (bound) bytesToHex(config.serverNoisePub) else null,
        "tunnelHost" to config.serverHost,
        "tunnelPort" to config.serverPort,
        "boundAt" to null
      )
    }

    AsyncFunction("bindNoise") { input: Map<String, Any?> ->
      val signature = (input["signature"] as? String)
        ?: throw IllegalArgumentException("signature required")
      val serverPubHex = (input["serverPublicKey"] as? String)
        ?: throw IllegalArgumentException("serverPublicKey required")
      val walletAddress = (input["walletAddress"] as? String) ?: ""
      input["tunnelHost"]?.let { config.serverHost = it.toString() }
      input["tunnelPort"]?.let { config.serverPort = (it as Number).toInt() }

      val derived = Noisemobile.deriveSeedFromSignatureHex(signature)
      val serverPub = hexToBytes(serverPubHex)
      if (serverPub.size != 32) {
        throw IllegalArgumentException("serverPublicKey must be 64 hex chars")
      }
      config.noiseSeed = derived.priv
      config.serverNoisePub = serverPub
      config.walletAddress = walletAddress
      appContext.reactContext?.let { persistNoiseBinding(it) }

      mapOf(
        "ok" to true,
        "bound" to true,
        "walletAddress" to walletAddress.ifEmpty { null },
        "clientPublicKey" to bytesToHex(derived.pub),
        "serverPublicKey" to serverPubHex.lowercase(),
        "tunnelHost" to config.serverHost,
        "tunnelPort" to config.serverPort
      )
    }

    AsyncFunction("unbindNoise") { ->
      config.noiseSeed = ByteArray(0)
      config.serverNoisePub = ByteArray(0)
      config.walletAddress = ""
      appContext.reactContext?.let {
        try { noiseKeyFile(it).delete() } catch (_: Throwable) {}
        try { noiseBindingFile(it).delete() } catch (_: Throwable) {}
      }
      mapOf("ok" to true, "bound" to false)
    }

    AsyncFunction("up") { promise: Promise ->
      ioScope.launch { upFlow(promise) }
    }

    AsyncFunction("down") { promise: Promise ->
      val ctx = appContext.reactContext ?: return@AsyncFunction promise.reject(
        Exceptions.AppContextLost()
      )
      ctx.startService(BlockchainVpnService.stopIntent(ctx))
      BlockchainVpnService.currentState.set(BlockchainVpnService.Companion.State.DOWN)
      promise.resolve(okResult("down", "stopped", "tunnel stopped"))
    }

    AsyncFunction("toggle") { promise: Promise ->
      val state = BlockchainVpnService.currentState.get()
      if (state == BlockchainVpnService.Companion.State.UP) {
        val ctx = appContext.reactContext
        if (ctx != null) ctx.startService(BlockchainVpnService.stopIntent(ctx))
        BlockchainVpnService.currentState.set(BlockchainVpnService.Companion.State.DOWN)
        promise.resolve(okResult("toggle", "toggled", "tunnel stopped"))
      } else {
        ioScope.launch { upFlow(promise) }
      }
    }

    AsyncFunction("restart") { promise: Promise ->
      ioScope.launch {
        val ctx = appContext.reactContext
        if (ctx != null) {
          ctx.startService(BlockchainVpnService.stopIntent(ctx))
          BlockchainVpnService.currentState.set(BlockchainVpnService.Companion.State.DOWN)
          Thread.sleep(300)
        }
        upFlow(promise)
      }
    }

    AsyncFunction("status") { -> currentStatus() }
    AsyncFunction("health") { -> currentStatus("health") }

    AsyncFunction("publicIp") { promise: Promise ->
      ioScope.launch {
        promise.resolve(
          try {
            val ip = httpGetText("https://api.ipify.org")
            val state = buildStateMap(publicIp = ip)
            mapOf(
              "ok" to true,
              "command" to "public-ip",
              "code" to "public_ip",
              "message" to "public ip resolved",
              "state" to state
            )
          } catch (t: Throwable) {
            errResult("public-ip", "public_ip_unavailable", t.message ?: "")
          }
        )
      }
    }

    AsyncFunction("isEnabled") { ->
      val enabled = BlockchainVpnService.currentState.get() == BlockchainVpnService.Companion.State.UP
      mapOf(
        "ok" to true,
        "command" to "is-enabled",
        "code" to if (enabled) "enabled" else "not_enabled",
        "message" to if (enabled) "tunnel enabled" else "tunnel disabled",
        "state" to buildStateMap()
      )
    }

    AsyncFunction("logs") { _: Int ->
      // Android logcat is owned by the OS; surfacing it cleanly to JS is a
      // separate piece of work. For now return an empty buffer.
      mapOf(
        "ok" to true,
        "command" to "logs",
        "code" to "logs",
        "message" to "logs not yet wired through native bridge; use `adb logcat -s BlockchainVpnService`",
        "logs" to ""
      )
    }

    OnActivityResult { _, result ->
      // VPN consent dialog result.
      val promise = pendingPermission.getAndSet(null) ?: return@OnActivityResult
      if (result.resultCode == Activity.RESULT_OK) {
        ioScope.launch { upAfterPermission(promise) }
      } else {
        promise.resolve(errResult("up", "permission_denied", "User declined VPN permission"))
      }
    }
  }

  // --- flow helpers ---

  private fun upFlow(promise: Promise) {
    val ctx = appContext.reactContext ?: return promise.reject(Exceptions.AppContextLost())
    val intent = VpnService.prepare(ctx)
    if (intent != null) {
      // User consent required; capture the promise and launch the dialog.
      pendingPermission.set(promise)
      val activity = appContext.currentActivity
      if (activity == null) {
        pendingPermission.set(null)
        promise.resolve(errResult("up", "permission_required", "VPN permission requires foreground activity"))
        return
      }
      activity.startActivityForResult(intent, VPN_PERMISSION_REQUEST_CODE)
      return
    }
    upAfterPermission(promise)
  }

  private fun upAfterPermission(promise: Promise) {
    val ctx = appContext.reactContext ?: return promise.reject(Exceptions.AppContextLost())
    try {
      if (config.noiseSeed.size != 32 || config.serverNoisePub.size != 32) {
        promise.resolve(errResult("up", "not_paired",
          "Noise identity not bound. Open the desktop pairing flow and call bindNoise()."))
        return
      }
      val (clientId, leasedCidr, leasedGateway) = allocateLease()
      val cfg = BlockchainVpnService.Config(
        serverHost = config.serverHost,
        serverPort = config.serverPort,
        tunCidr = leasedCidr,
        tunGateway = leasedGateway,
        mtu = config.mtu,
        routeDefault = config.routeDefault,
        sessionName = "blockchain-vpn ($clientId)",
        noiseSeed = config.noiseSeed,
        serverNoisePub = config.serverNoisePub
      )
      ctx.startForegroundService(BlockchainVpnService.startIntent(ctx, cfg))
      BlockchainVpnService.currentState.set(BlockchainVpnService.Companion.State.UP)
      config.clientId = clientId
      promise.resolve(
        mapOf(
          "ok" to true,
          "command" to "up",
          "code" to "started",
          "message" to "tunnel started with cidr=$leasedCidr",
          "state" to buildStateMap(tunCidr = leasedCidr, tunGateway = leasedGateway)
        )
      )
    } catch (t: Throwable) {
      BlockchainVpnService.currentState.set(BlockchainVpnService.Companion.State.ERROR)
      BlockchainVpnService.lastError.set(t.message)
      promise.resolve(errResult("up", "bridge_runner_failed", t.message ?: t.javaClass.simpleName))
    }
  }

  private data class Lease(val clientId: String, val cidr: String, val gateway: String)

  private fun allocateLease(): Lease {
    val url = URL(config.controlBaseUrl.trimEnd('/') + "/v1/tunnel/lease")
    val conn = url.openConnection() as HttpURLConnection
    conn.requestMethod = "POST"
    conn.doOutput = true
    conn.connectTimeout = 5_000
    conn.readTimeout = 10_000
    conn.setRequestProperty("Content-Type", "application/json")
    if (config.controlToken.isNotEmpty()) {
      conn.setRequestProperty("Authorization", "Bearer ${config.controlToken}")
    }
    val body = JSONObject().apply {
      if (config.clientId.isNotEmpty()) put("clientId", config.clientId)
      put("platform", "android")
      put("deviceName", android.os.Build.MODEL ?: "android")
    }.toString()
    conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
    val status = conn.responseCode
    val text = (if (status in 200..299) conn.inputStream else conn.errorStream)
      .bufferedReader().use { it.readText() }
    if (status !in 200..299) {
      throw IllegalStateException("control plane $status: $text")
    }
    val json = JSONObject(text)
    val clientId = json.optString("clientId").ifEmpty { config.clientId }
    val leaseObj = json.optJSONObject("lease")
      ?: throw IllegalStateException("control plane response has no lease: $text")
    val cidr = leaseObj.optString("cidr").ifEmpty { throw IllegalStateException("lease.cidr missing") }
    val gateway = leaseObj.optString("gateway").ifEmpty { config.serverHost }
    return Lease(clientId, cidr, gateway)
  }

  private fun httpGetText(url: String): String {
    val conn = URL(url).openConnection() as HttpURLConnection
    conn.connectTimeout = 5_000
    conn.readTimeout = 5_000
    return conn.inputStream.bufferedReader().use { it.readText().trim() }
  }

  // --- state map builders ---

  private fun currentStatus(command: String = "status"): Map<String, Any?> {
    val st = BlockchainVpnService.currentState.get()
    val up = st == BlockchainVpnService.Companion.State.UP
    return mapOf(
      "ok" to true,
      "command" to command,
      "code" to if (command == "health") if (up) "healthy" else "unhealthy" else "status",
      "message" to if (up) "tunnel running" else "tunnel not running",
      "state" to buildStateMap()
    )
  }

  private fun buildStateMap(
    tunCidr: String = "",
    tunGateway: String = "",
    publicIp: String? = null
  ): Map<String, Any?> {
    val st = BlockchainVpnService.currentState.get()
    val up = st == BlockchainVpnService.Companion.State.UP
    return mapOf(
      "service" to if (up) "active" else "inactive",
      "enabled" to if (up) "enabled" else "disabled",
      "backend" to "android-vpnservice",
      "tunnel" to if (up) "up" else "down",
      "default_route" to if (up && config.routeDefault) "on" else "off",
      "tun_name" to "blockchain-vpn",
      "server" to "${config.serverHost}:${config.serverPort}",
      "pid" to null,
      "default_route_line" to "",
      "server_route_line" to "",
      "public_ip" to publicIp,
      "client_id" to config.clientId,
      "tun_cidr" to tunCidr,
      "tun_gateway" to tunGateway,
      "last_error" to BlockchainVpnService.lastError.get()
    )
  }

  private fun okResult(command: String, code: String, message: String): Map<String, Any?> =
    mapOf(
      "ok" to true,
      "command" to command,
      "code" to code,
      "message" to message,
      "state" to buildStateMap()
    )

  private fun errResult(command: String, code: String, message: String): Map<String, Any?> =
    mapOf(
      "ok" to false,
      "command" to command,
      "code" to code,
      "message" to message,
      "state" to buildStateMap()
    )

  // --- BuildConfig overrides (host app can bake defaults at build time) ---

  private fun tryLoadBuildConfig(): Map<String, String>? = try {
    val ctx = appContext.reactContext ?: return null
    val cls = Class.forName("${ctx.packageName}.BuildConfig")
    val map = mutableMapOf<String, String>()
    listOf(
      "BVPN_TUN_SERVER" to "serverHost",
      "BVPN_TUN_API_URL" to "controlBaseUrl",
      "BVPN_TUN_API_TOKEN" to "controlToken",
      "BVPN_TUN_CLIENT_ID" to "clientId"
    ).forEach { (field, key) ->
      try {
        val value = cls.getField(field).get(null) as? String
        if (!value.isNullOrEmpty()) map[key] = value
      } catch (_: NoSuchFieldException) {}
    }
    map.takeIf { it.isNotEmpty() }
  } catch (_: Throwable) {
    null
  }

  private fun merge(overrides: Map<String, String>) {
    overrides["serverHost"]?.let {
      val parts = it.split(':')
      config.serverHost = parts[0]
      if (parts.size > 1) config.serverPort = parts[1].toIntOrNull() ?: config.serverPort
    }
    overrides["controlBaseUrl"]?.let { config.controlBaseUrl = it }
    overrides["controlToken"]?.let { config.controlToken = it }
    overrides["clientId"]?.let { config.clientId = it }
  }

  // --- Noise binding persistence + hex helpers ---

  private fun persistNoiseBinding(ctx: Context) {
    if (config.noiseSeed.size != 32 || config.serverNoisePub.size != 32) return
    try {
      val keyFile = noiseKeyFile(ctx)
      keyFile.writeBytes(config.noiseSeed)
      try { keyFile.setReadable(false, false); keyFile.setReadable(true, true) } catch (_: Throwable) {}
      try { keyFile.setWritable(false, false); keyFile.setWritable(true, true) } catch (_: Throwable) {}

      val pub = try { Noisemobile.publicKeyHex(config.noiseSeed) } catch (_: Throwable) { "" }
      val json = JSONObject().apply {
        put("walletAddress", config.walletAddress)
        put("clientPublicKey", pub)
        put("serverPublicKey", bytesToHex(config.serverNoisePub))
        put("tunnelHost", config.serverHost)
        put("tunnelPort", config.serverPort)
      }
      noiseBindingFile(ctx).writeText(json.toString(), Charsets.UTF_8)
    } catch (_: Throwable) {
      // best-effort; pairing still works in-memory for this session
    }
  }

  private fun loadPersistedNoiseBinding(ctx: Context) {
    try {
      val keyFile = noiseKeyFile(ctx)
      val bindingFile = noiseBindingFile(ctx)
      if (!keyFile.exists() || !bindingFile.exists()) return
      val seed = keyFile.readBytes()
      if (seed.size != 32) return
      val json = JSONObject(bindingFile.readText(Charsets.UTF_8))
      val serverPubHex = json.optString("serverPublicKey")
      if (serverPubHex.length != 64) return
      val serverPub = hexToBytes(serverPubHex)
      if (serverPub.size != 32) return
      config.noiseSeed = seed
      config.serverNoisePub = serverPub
      config.walletAddress = json.optString("walletAddress")
      json.optString("tunnelHost").takeIf { it.isNotEmpty() }?.let { config.serverHost = it }
      val port = json.optInt("tunnelPort", 0)
      if (port > 0) config.serverPort = port
    } catch (_: Throwable) {
      // ignore — leaves the user on the pair screen
    }
  }

  private fun bytesToHex(b: ByteArray): String =
    b.joinToString("") { "%02x".format(it.toInt() and 0xff) }

  private fun hexToBytes(hex: String): ByteArray {
    val s = if (hex.startsWith("0x") || hex.startsWith("0X")) hex.substring(2) else hex
    if (s.length % 2 != 0) return ByteArray(0)
    val out = ByteArray(s.length / 2)
    for (i in out.indices) {
      out[i] = ((Character.digit(s[i * 2], 16) shl 4) or Character.digit(s[i * 2 + 1], 16)).toByte()
    }
    return out
  }

  private fun tryHex(value: String?): String? = value?.takeIf { it.isNotEmpty() }

  companion object {
    private const val VPN_PERMISSION_REQUEST_CODE = 0x42BC // 17084
  }
}
