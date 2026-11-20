// A thread moving between the inbox, hibernating and the archive leaves a
// `system.note` with a `move` (docs/protocol.md, "Moves in the transcript"),
// which the app draws as a divider with the time (Ville, 20 Nov 2026).

mod support;

use serde_json::json;
use support::*;
use threadbear_core::chrono::FixedOffset;
use threadbear_core::reducer::*;

#[test]
fn a_move_note_is_a_row_of_its_own_with_its_time() {
    let model = from_events(vec![
        event(1, "turn.started", json!({"turnId": "t1"})),
        user(2, "Fix the test"),
        call_titled(3, "c1", "npm test"),
        result_text(4, "c1", "ok"),
        text(5, "m1", "Fixed it."),
        done(6),
        event_no_turn(7, "system.note", json!({"text": "Hibernated by you until Monday 24 November, 9 am.", "move": {"from": "inbox", "to": "hibernating", "by": "mike", "until": "2026-11-24T07:00:00.000Z"}})),
        event_no_turn(8, "system.note", json!({"text": "Woken by you after 2 hours.", "move": {"from": "hibernating", "to": "inbox", "by": "mike"}})),
    ]);
    assert_eq!(ids(&model), ["u:2", "g:t:c1", "a:m1", "f:t1", "n:7", "n:8"]);
    let RowContent::Move(note) = &model.items().iter().find(|r| r.id == "n:7").expect("n:7").content else { panic!("a move") };
    assert_eq!(note.text, "Hibernated by you until Monday 24 November, 9 am.");
    assert_eq!((note.from.as_str(), note.to.as_str(), note.by.as_str()), ("inbox", "hibernating", "mike"));
    assert_eq!(note.icon(), MoveIcon::Hibernate);
    let helsinki = FixedOffset::east_opt(2 * 3600).unwrap();
    assert_eq!(note.when(&helsinki), "Mon 26 Oct, 12:00 pm");
    assert_eq!(note.full_when(&helsinki), "26 Oct 2026 at 12:00 pm");
    let RowContent::Move(woke) = &model.items().iter().find(|r| r.id == "n:8").expect("n:8").content else { panic!("a move") };
    assert_eq!(woke.icon(), MoveIcon::Wake);
}

#[test]
fn a_move_inside_a_turn_never_folds_into_its_work() {
    let model = from_events(vec![
        event(1, "turn.started", json!({"turnId": "t1"})),
        user(2, "Fix the test"),
        call_titled(3, "c1", "npm test"),
        result_text(4, "c1", "ok"),
        event(5, "system.note", json!({"text": "Archived by you.", "move": {"from": "inbox", "to": "archived", "by": "mike"}})),
        call_titled(6, "c2", "npm test"),
        result_text(7, "c2", "ok"),
    ]);
    assert!(ids(&model).contains(&"n:5".to_owned()));
    let row = model.rows().iter().find(|r| r.id == "n:5").unwrap();
    assert!(!row.in_group);
}

#[test]
fn the_icons() {
    let at = |from: &str, to: &str| MoveNote { text: String::new(), from: from.into(), to: to.into(), by: "mike".into(), at: String::new() }.icon();
    assert_eq!(at("inbox", "archived"), MoveIcon::Archive);
    assert_eq!(at("hibernating", "archived"), MoveIcon::Archive);
    assert_eq!(at("archived", "inbox"), MoveIcon::Inbox);
    assert_eq!(at("hibernating", "hibernating"), MoveIcon::Hibernate);
    assert_eq!(at("hibernating", "inbox"), MoveIcon::Wake);
}

#[test]
fn a_note_without_a_move_is_still_a_note() {
    let model = from_events(vec![event_no_turn(1, "system.note", json!({"text": "Woke up after hibernating for 2 days."}))]);
    assert!(matches!(&model.items()[0].content, RowContent::Note(_)));
}
