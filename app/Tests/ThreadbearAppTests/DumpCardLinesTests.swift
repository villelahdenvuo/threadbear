import XCTest
@testable import Threadbear
@testable import ThreadbearCore

/// `dump`'s composer card says what the card draws, a command to run
/// included: the nightly parity run reads it to check the Mac shows a
/// scenario's words, and missed the command on the card's Run block (11 Nov).
final class DumpCardLinesTests: XCTestCase {
    func testAnAskWithACommandGetsALineOfItsOwnUnderIt() {
        var ask = Ask(action: "Backfill the titles on prod?")
        ask.run = AskRun(command: "npx convex run --prod migrations:backfill", cwd: "/w")
        let card = AsksCard(seq: 3, asks: [ask, Ask(action: "Then tell Nipunn")], picks: [1: 0])
        XCTAssertEqual(AppDump.cardLines(card, collapsed: false), [
            "Needs you",
            "[ ] 1. Backfill the titles on prod?",
            "    $ npx convex run --prod migrations:backfill",
            "[x] 2. Then tell Nipunn",
        ])
    }

    func testDoneAndCollapsed() {
        let done = AsksCard(seq: 3, asks: [], next: ["A", "B"], pickedNext: [1], explainNext: [0])
        XCTAssertEqual(AppDump.cardLines(done, collapsed: false), ["Done", "[ ] A (?)", "[x] B"])
        XCTAssertEqual(AppDump.cardLines(AsksCard(seq: 3, asks: [Ask(action: "Go")]), collapsed: true), ["Needs you (collapsed)", "[ ] 1. Go"])
    }

    /// A done card while background work still runs (a land, a build):
    /// "Still running", with no Done and no Archive until it's over (Ville,
    /// 12 Nov). A closed one is just the old Done.
    func testADoneCardHoldsDoneAndArchiveWhileAJobRuns() {
        var card = AsksCard(seq: 3, asks: [], next: ["A"])
        card.running = [BackgroundTask(kind: .shell, description: "tb land")]
        XCTAssertEqual(AppDump.cardLines(card, collapsed: false), ["Still running", "[ ] A"])
        let drawn = RowRenderer.asksText(card).string
        XCTAssertTrue(drawn.contains("Still running"))
        XCTAssertFalse(drawn.contains("Archive"))
        XCTAssertFalse(drawn.contains("Done"))
        card.running = []
        XCTAssertTrue(RowRenderer.asksText(card).string.contains("Archive"))
        card.running = [BackgroundTask(kind: .shell, description: "tb land")]
        card.isOpen = false
        XCTAssertEqual(AppDump.cardLines(card, collapsed: false).first, "Done")
    }
}
