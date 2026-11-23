package com.mikerosoft.threadbear.kit

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * A thread moving between the inbox, hibernating and the archive, on its
 * note's row (backend API 99; docs/protocol/threads.md, "Moves in the
 * transcript"). Drawn as the Mac's move divider: a line across with an
 * icon, the runner's words and when (MoveNote in desktop/core, ThreadMove.swift).
 */
data class ThreadMove(val from: String, val to: String, val by: String = "threadbear") {
    enum class Icon { HIBERNATE, WAKE, ARCHIVE, INBOX }

    /** A moon for hibernating, a sun for a wake, else where it went. */
    val icon: Icon
        get() = when {
            to == "hibernating" -> Icon.HIBERNATE
            to == "archived" -> Icon.ARCHIVE
            from == "hibernating" -> Icon.WAKE
            else -> Icon.INBOX
        }

    companion object {
        /** The note's words as the divider says them: no full stop at the end. */
        fun words(text: String): String = text.trim().trimEnd('.')

        /** "Thu 20 Nov, 2:32 pm", as the Mac's divider says when. */
        fun `when`(at: Instant, zone: ZoneId = ZoneId.systemDefault()): String =
            DateTimeFormatter.ofPattern("EEE d MMM, ", Locale.ENGLISH).withZone(zone).format(at) + timeOfDay(at, zone)

        /** "20 Nov 2026 at 2:32 pm", in full. */
        fun fullWhen(at: Instant, zone: ZoneId = ZoneId.systemDefault()): String =
            DateTimeFormatter.ofPattern("d MMM yyyy 'at' ", Locale.ENGLISH).withZone(zone).format(at) + timeOfDay(at, zone)

        private fun timeOfDay(at: Instant, zone: ZoneId): String {
            val t = at.atZone(zone)
            val twelve = if (t.hour % 12 == 0) 12 else t.hour % 12
            return "$twelve:${"%02d".format(t.minute)} ${if (t.hour < 12) "am" else "pm"}"
        }
    }
}
