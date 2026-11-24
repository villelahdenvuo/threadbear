package com.mikerosoft.threadbear.kit

import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals

/** The 15-minute check's notifications (ThreadCheck): once per time a thread needs you. */
class ThreadCheckTest {
    private fun thread(id: String, needsYou: Boolean, at: Long = 1000, archived: Boolean = false) =
        PhoneThread(
            threadId = id, title = id, needsYou = needsYou, lastActivityAt = Instant.ofEpochMilli(at),
            archivedAt = if (archived) Instant.ofEpochMilli(at) else null,
        )

    @Test fun notifiesEachThreadOncePerTimeItNeedsYou() {
        val first = ThreadCheck.plan(listOf(thread("a", true), thread("b", false), thread("c", true, archived = true)), emptySet())
        assertEquals(listOf("a"), first.show.map { it.threadId })
        assertEquals(setOf("a@1000"), first.notified)
        // The next check, nothing changed: nothing new, nothing taken down.
        val again = ThreadCheck.plan(listOf(thread("a", true)), first.notified)
        assertEquals(emptyList(), again.show)
        assertEquals(emptySet(), again.clear)
        // A later turn that needs you again notifies again.
        assertEquals(listOf("a"), ThreadCheck.plan(listOf(thread("a", true, at = 2000)), first.notified).show.map { it.threadId })
    }

    @Test fun takesDownWhatNoLongerNeedsYou() {
        val plan = ThreadCheck.plan(listOf(thread("a", false)), setOf("a@1000", "gone@5"))
        assertEquals(setOf("a", "gone"), plan.clear)
        assertEquals(emptySet(), plan.notified)
    }
}
