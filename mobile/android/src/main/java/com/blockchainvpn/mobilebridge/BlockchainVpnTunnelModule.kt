package com.blockchainvpn.mobilebridge

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap

class BlockchainVpnTunnelModule(
    reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "BlockchainVpnTunnel"

    @ReactMethod
    fun up(promise: Promise) = resolveNotSupported("up", promise)

    @ReactMethod
    fun down(promise: Promise) = resolveNotSupported("down", promise)

    @ReactMethod
    fun toggle(promise: Promise) = resolveNotSupported("toggle", promise)

    @ReactMethod
    fun restart(promise: Promise) = resolveNotSupported("restart", promise)

    @ReactMethod
    fun status(promise: Promise) = resolveNotSupported("status", promise)

    @ReactMethod
    fun health(promise: Promise) = resolveNotSupported("health", promise)

    @ReactMethod
    fun publicIp(promise: Promise) = resolveNotSupported("public-ip", promise)

    @ReactMethod
    fun isEnabled(promise: Promise) = resolveNotSupported("is-enabled", promise)

    @ReactMethod
    fun logs(count: Double, promise: Promise) {
        resolveNotSupported("logs", promise)
    }

    private fun resolveNotSupported(command: String, promise: Promise) {
        val result = Arguments.createMap().apply {
            putBoolean("ok", false)
            putString("command", command)
            putString("code", "not_supported")
            putString(
                "message",
                "Android bridge is registered, but tunnel operations still need a VpnService-backed implementation."
            )
            putMap("state", emptyState())
        }
        promise.resolve(result)
    }

    private fun emptyState(): WritableMap {
        return Arguments.createMap().apply {
            putString("service", "inactive")
            putString("enabled", "disabled")
            putString("backend", "android")
            putString("tunnel", "down")
            putString("default_route", "off")
            putString("tun_name", "")
            putString("server", "")
            putNull("pid")
            putString("default_route_line", "")
            putString("server_route_line", "")
            putNull("public_ip")
        }
    }
}
