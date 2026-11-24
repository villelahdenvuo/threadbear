package com.mikerosoft.threadbear.kit

/**
 * The Android app's check every 15 minutes, for a phone with no push (a
 * fork's own build, which Mike's relay can't reach): which threads to
 * notify about and which notifications to take down, from the inbox and
 * what the last check notified. A thread is notified once each time it
 * comes to need you: its id with its last activity is the key, so a later
 * turn that needs you again notifies again, and one swiped away stays away.
 */
object ThreadCheck {
    data class Plan(val show: List<PhoneThread>, val clear: Set<String>, val notified: Set<String>)

    fun key(thread: PhoneThread) = "${thread.threadId}@${thread.lastActivityAt.toEpochMilli()}"

    private fun idOf(key: String) = key.substringBeforeLast('@')

    fun needsYou(thread: PhoneThread) = thread.needsYou && thread.archivedAt == null && thread.snoozedUntil == null

    fun plan(threads: List<PhoneThread>, notified: Set<String>): Plan {
        val needing = threads.filter(::needsYou).associateBy(::key)
        val show = needing.filterKeys { it !in notified }.values.toList()
        val still = needing.values.map { it.threadId }.toSet()
        val clear = notified.map(::idOf).filter { it !in still }.toSet()
        return Plan(show, clear, needing.keys)
    }
}
