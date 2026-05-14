package expo.modules.blockchainvpntunnel

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject
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
    var routeDefault: Boolean = true
  )

  private val config = ClientConfig()
  private val pendingPermission = AtomicReference<Promise?>(null)
  private val ioScope = CoroutineScope(Dispatchers.IO)

  override fun definition() = ModuleDefinition {
    Name("BlockchainVpnTunnel")

    OnCreate {
      // Pick up override values from BuildConfig if the host app set them.
      tryLoadBuildConfig()?.let { merge(it) }
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
      val (clientId, leasedCidr, leasedGateway) = allocateLease()
      val cfg = BlockchainVpnService.Config(
        serverHost = config.serverHost,
        serverPort = config.serverPort,
        tunCidr = leasedCidr,
        tunGateway = leasedGateway,
        mtu = config.mtu,
        routeDefault = config.routeDefault,
        sessionName = "blockchain-vpn ($clientId)"
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

  companion object {
    private const val VPN_PERMISSION_REQUEST_CODE = 0x42BC // 17084
  }
}
