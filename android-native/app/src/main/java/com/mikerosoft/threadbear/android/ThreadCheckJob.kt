package com.mikerosoft.threadbear.android

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import com.mikerosoft.threadbear.kit.ThreadCheck
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Settings > Check every 15 minutes: Android's job scheduler wakes the app
 * about every 15 minutes (its shortest), and it notifies about each thread
 * that has come to need you since (ThreadCheck in the kit). For a phone
 * push doesn't reach: a fork's own build, which Mike's relay can't send
 * to. Android stretches the gaps while the phone lies idle, and further
 * for an app it treats as seldom used, unless battery optimisation is off
 * for it. Off by default.
 */
object ThreadChecks {
    private const val JOB = 4401
    private const val EVERY_MS = 15 * 60 * 1000L

    private fun prefs(context: Context) = context.getSharedPreferences("threadCheck", Context.MODE_PRIVATE)

    fun on(context: Context): Boolean = prefs(context).getBoolean("on", false)

    fun set(context: Context, on: Boolean) {
        prefs(context).edit().putBoolean("on", on).apply()
        schedule(context)
    }

    /** Booked while on and paired, else cancelled. Called at start, on the switch, and on pairing. */
    fun schedule(context: Context) {
        val scheduler = context.getSystemService(JobScheduler::class.java)
        if (!on(context) || !PairingStore(context).paired()) {
            scheduler.cancel(JOB)
            forget(context)
            return
        }
        if (scheduler.getPendingJob(JOB) != null) return
        val job = JobInfo.Builder(JOB, ComponentName(context, ThreadCheckJob::class.java))
            .setPeriodic(EVERY_MS)
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPersisted(true)
            .build()
        scheduler.schedule(job)
    }

    /** What the last check notified, so a new pairing starts afresh. */
    fun forget(context: Context) { prefs(context).edit().remove("notified").apply() }

    suspend fun run(context: Context, model: AppModel) {
        if (!on(context) || !PairingStore(context).paired()) return
        // The app's in front: the inbox shows what needs you already.
        val inFront = withContext(Dispatchers.Main) { ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) }
        val threads = withTimeoutOrNull(30_000) { model.inbox.first { it != null } } ?: return
        val p = prefs(context)
        val plan = ThreadCheck.plan(threads, p.getStringSet("notified", emptySet()) ?: emptySet())
        if (!inFront) plan.show.forEach { Push.showPlain(context, it.threadId, it.title, it.preview) }
        plan.clear.forEach { Push.clear(context, it) }
        p.edit().putStringSet("notified", plan.notified).apply()
    }
}

class ThreadCheckJob : JobService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var running: Job? = null

    override fun onStartJob(params: JobParameters): Boolean {
        val model = (application as ThreadbearApplication).model
        running = scope.launch {
            try {
                ThreadChecks.run(this@ThreadCheckJob, model)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (_: Exception) {
                // The next check tries again.
            } finally {
                jobFinished(params, false)
            }
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean {
        running?.cancel()
        return false
    }
}
