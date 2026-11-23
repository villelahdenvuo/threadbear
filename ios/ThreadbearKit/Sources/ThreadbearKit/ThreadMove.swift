import Foundation

/// A thread moving between the inbox, hibernating and the archive, on its
/// note's row (backend API 99; docs/protocol/threads.md, "Moves in the
/// transcript"). Drawn as the Mac's move divider: a line across with an
/// icon, the runner's words and when (MoveNote in desktop/core).
public struct ThreadMove: Codable, Sendable, Hashable {
    /// "inbox", "hibernating" or "archived".
    public var from: String
    public var to: String
    /// "mike", "agent", "schedule", "thread" or "threadbear".
    public var by: String

    public init(from: String, to: String, by: String = "threadbear") {
        self.from = from
        self.to = to
        self.by = by
    }

    public enum Icon: Sendable { case hibernate, wake, archive, inbox }

    /// A moon for hibernating, a sun for a wake, else where it went.
    public var icon: Icon {
        if to == "hibernating" { return .hibernate }
        if to == "archived" { return .archive }
        if from == "hibernating" { return .wake }
        return .inbox
    }

    /// The note's words as the divider says them: no full stop at the end.
    public static func words(_ text: String) -> String {
        var t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        while t.hasSuffix(".") { t.removeLast() }
        return t
    }

    /// "Thu 20 Nov, 2:32 pm", as the Mac's divider says when.
    public static func when(_ date: Date, timeZone: TimeZone = .current) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = timeZone
        f.dateFormat = "EEE d MMM, "
        return f.string(from: date) + timeOfDay(date, timeZone: timeZone)
    }

    /// "20 Nov 2026 at 2:32 pm", in full.
    public static func fullWhen(_ date: Date, timeZone: TimeZone = .current) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = timeZone
        f.dateFormat = "d MMM yyyy 'at' "
        return f.string(from: date) + timeOfDay(date, timeZone: timeZone)
    }

    static func timeOfDay(_ date: Date, timeZone: TimeZone) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = timeZone
        let c = cal.dateComponents([.hour, .minute], from: date)
        let hour = c.hour ?? 0, minute = c.minute ?? 0
        let twelve = hour % 12 == 0 ? 12 : hour % 12
        return "\(twelve):" + String(format: "%02d", minute) + (hour < 12 ? " am" : " pm")
    }
}
