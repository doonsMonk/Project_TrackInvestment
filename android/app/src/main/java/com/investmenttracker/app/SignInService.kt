package com.investmenttracker.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper

/**
 * Keeps the app's process running while the phone's browser shows a cloud provider's sign-in page.
 *
 * Android freezes an app within seconds of it leaving the screen, and the provider sends the browser back to the
 * app's own address (http://127.0.0.1:8000/api/cloud/callback), which only the running backend can answer. A
 * foreground service with a small notification is the sanctioned way to stay alive. It stops as soon as the app
 * is back in front (MainActivity.onResume), or after five minutes.
 */
class SignInService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private val stopper = Runnable { stopSelf() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, getString(R.string.signin_channel), NotificationManager.IMPORTANCE_LOW))
        }
        val back = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE,
        )
        @Suppress("DEPRECATION")
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
        val notification = builder
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(getString(R.string.signin_title))
            .setContentText(getString(R.string.signin_text))
            .setContentIntent(back)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(ID, notification)
        }
        handler.removeCallbacks(stopper)
        handler.postDelayed(stopper, TIMEOUT_MS)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(stopper)
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "signin"
        private const val ID = 7
        private const val TIMEOUT_MS = 5 * 60 * 1000L

        /** Called while the activity is in front (the user pressed Connect), which is when Android allows it. */
        fun start(context: Context) {
            val intent = Intent(context, SignInService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, SignInService::class.java))
        }
    }
}
