use super::Order;
use serde_json::{Value, json};

const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const C: &str = "cccccccccccccccccccccccccc";
const D: &str = "dddddddddddddddddddddddddd";
const VIEWER: &str = "vvvvvvvvvvvvvvvvvvvvvvvvvv";
const LOCAL: &str = "local";

fn device(id: &str) -> Order {
    Order::new(id, &Value::Null).unwrap()
}

fn ids<const N: usize>(values: [&str; N]) -> [String; N] {
    values.map(str::to_owned)
}

#[test]
fn first_move_keeps_the_released_wire_format() {
    let mut model = device(A);
    model.set(&json!([LOCAL, B]), &ids([B])).unwrap();
    let writer = "29fb052adc62fc4ccd00a98c813b8838";
    assert_eq!(
        model.wire(),
        json!([
            [writer, 0, 1, writer],
            ["e56a6f99eedd2ac0d48590c41c9170d5", 1, 1, writer]
        ])
    );
}

#[test]
fn empty_edits_and_migration_leave_an_untouched_order_unranked() {
    let mut model = device(A);
    assert!(!model.migrate(&json!([]), &ids([B])));
    assert!(model.view(&ids([C, B])).is_empty());
    assert!(!model.set(&json!([]), &ids([C, B])).unwrap());
    assert!(!model.merge(&json!([])));
    assert_eq!(model.wire(), json!([]));
}

#[test]
fn legacy_import_admits_only_known_ids_and_relays_no_raw_id_name_or_path() {
    let mut model = device(A);
    let name = "Example studio";
    let path = "/synthetic/private";
    assert!(model.view(&[]).is_empty());
    assert!(model.migrate(&json!([name, C, B, B, path, LOCAL, D]), &ids([B, D])));
    assert_eq!(model.view(&ids([B])), [B, LOCAL]);
    assert_eq!(model.view(&ids([D, C, B])), [B, LOCAL, D, C]);
    let rows = model.wire();
    let payload = rows.to_string();
    for private in [A, B, C, D, LOCAL, name, path, "knownHosts"] {
        assert!(!payload.contains(private));
    }
    assert_eq!(rows.as_array().unwrap().len(), 3);
    let mut remote = device(B);
    assert!(remote.merge(&serde_json::from_str(&payload).unwrap()));
    assert_eq!(remote.view(&ids([C, A, D])), [LOCAL, A, D, C]);
    let restored = Order::new(A, &rows).unwrap();
    assert_eq!(restored.wire(), rows);
    assert_eq!(restored.view(&ids([C, D, B])), [B, LOCAL, D, C]);
}

#[test]
fn modern_edits_win_over_legacy_rows_in_either_delivery_order() {
    let mut desktop = device(A);
    let mut laptop = device(B);
    laptop.set(&json!([A, LOCAL]), &ids([A])).unwrap();
    let modern = laptop.wire();
    assert!(desktop.migrate(&json!([B, LOCAL]), &ids([B])));
    assert!(!laptop.merge(&desktop.wire()));
    assert!(desktop.merge(&modern));
    assert_eq!(desktop.view(&ids([B])), [LOCAL, B]);
    let mut late = device(B);
    late.merge(&modern);
    assert!(!late.migrate(&json!([LOCAL, A]), &ids([A])));
    assert_eq!(late.wire(), modern);
}

#[test]
fn unseen_hosts_keep_their_slots_across_relays_and_local_is_viewer_relative() {
    let mut source = device(A);
    let mut relay = device(B);
    let mut end = device(C);
    source.set(&json!([LOCAL, C, B]), &ids([B, C])).unwrap();
    assert!(relay.merge(&source.wire()));
    assert_eq!(relay.view(&ids([A])), [A, LOCAL]);
    assert!(relay.set(&json!([LOCAL, A]), &ids([A])).unwrap());
    assert!(!relay.set(&json!([LOCAL, A]), &ids([A])).unwrap());
    assert!(end.merge(&relay.wire()));
    assert_eq!(end.view(&ids([B])), [B, LOCAL]);
    assert!(source.merge(&end.wire()));
    assert_eq!(source.view(&ids([B, C])), [B, C, LOCAL]);
    assert_eq!(end.view(&ids([B, A, C])), [B, LOCAL, A]);
    assert!(!relay.merge(&end.wire()));
}

#[test]
fn unranked_hosts_including_self_follow_stable_id_order() {
    let mut desktop = device(A);
    let mut laptop = device(D);
    desktop.set(&json!([LOCAL]), &[]).unwrap();
    laptop.merge(&desktop.wire());
    assert_eq!(desktop.view(&ids([D, C, B])), [LOCAL, B, C, D]);
    assert_eq!(laptop.view(&ids([B, C, A])), [A, B, C, LOCAL]);
    assert_eq!(laptop.view(&ids([B, C])), [B, C, LOCAL]);
    assert!(!laptop.set(&json!([B, C, LOCAL]), &ids([B, C])).unwrap());
    assert_eq!(laptop.wire(), desktop.wire());
    assert!(laptop.set(&json!([LOCAL, B]), &ids([A, C, B])).unwrap());
    assert_eq!(laptop.view(&ids([A, B, C])), [A, LOCAL, C, B]);
}

#[test]
fn partial_edits_keep_omitted_and_offline_sections_in_place() {
    let mut model = device(A);
    model.set(&json!([B, LOCAL, C]), &ids([B, C])).unwrap();
    assert!(model.set(&json!([D, B]), &ids([B, D])).unwrap());
    assert_eq!(
        model.view(&ids([B, C, D, VIEWER])),
        [D, LOCAL, C, B, VIEWER]
    );
    assert!(!model.set(&json!([LOCAL, B]), &ids([B])).unwrap());
    assert_eq!(model.view(&ids([C, D])), [D, LOCAL, C]);
}

#[test]
fn equal_clocks_converge_in_either_delivery_order_and_ignore_retries() {
    let mut first = device(A);
    let mut second = device(B);
    first.set(&json!([B, LOCAL, C]), &ids([B, C])).unwrap();
    second.set(&json!([C, LOCAL, A]), &ids([A, C])).unwrap();
    let mut forward = device(VIEWER);
    let mut reverse = device(D);
    forward.merge(&first.wire());
    forward.merge(&second.wire());
    reverse.merge(&second.wire());
    reverse.merge(&first.wire());
    let hosts = ids([A, B, C]);
    let order = forward.view(&hosts);
    assert!(order == [B, A, C, LOCAL] || order == [C, B, A, LOCAL]);
    assert_eq!(reverse.view(&hosts), order);
    assert_eq!(reverse.wire(), forward.wire());
    let mut reordered = reverse.wire();
    reordered.as_array_mut().unwrap().reverse();
    assert!(!forward.merge(&reordered));
    assert!(!reverse.merge(&first.wire()));
}

#[test]
fn disjoint_moves_survive_four_isolated_claims_to_the_same_slot() {
    let mut left = device(VIEWER);
    let mut right = device("wwwwwwwwwwwwwwwwwwwwwwwwww");
    let hosts = ids([A, B, C, D]);
    for id in &hosts {
        let mut isolated = device(id);
        isolated.set(&json!([LOCAL]), &[]).unwrap();
        left.merge(&isolated.wire());
    }
    right.merge(&left.wire());
    let initial = left.view(&hosts);
    let [one, two, three, four, _] = initial.as_slice() else {
        panic!("expected four ranked hosts and local");
    };
    assert!(left.set(&json!([three, one]), &hosts).unwrap());
    assert_eq!(left.view(&hosts), ids([three, two, one, four, LOCAL]));
    assert!(right.set(&json!([four, two]), &hosts).unwrap());
    assert_eq!(right.view(&hosts), ids([one, four, three, two, LOCAL]));
    let right_only = right.wire();
    assert!(right.merge(&left.wire()));
    assert!(left.merge(&right_only));
    assert_eq!(right.view(&hosts), ids([three, four, one, two, LOCAL]));
    assert_eq!(left.wire(), right.wire());
}

#[test]
fn wire_roundtrip_restores_the_highest_observed_clock() {
    let mut first = device(A);
    for edit in [json!([LOCAL, B]), json!([B, LOCAL]), json!([LOCAL, B])] {
        assert!(first.set(&edit, &ids([B])).unwrap());
    }
    let old = first.wire();
    let mut second = device(B);
    assert!(second.merge(&old));
    let mut restored = Order::new(B, &second.wire()).unwrap();
    assert_eq!(restored.view(&ids([A])), [A, LOCAL]);
    assert!(restored.set(&json!([LOCAL, A]), &ids([A])).unwrap());
    assert!(first.merge(&restored.wire()));
    assert_eq!(first.view(&ids([B])), [B, LOCAL]);
    assert!(!Order::new(B, &restored.wire()).unwrap().merge(&old));
}

#[test]
fn invalid_edits_and_snapshots_commit_no_valid_prefix() {
    let mut model = device(A);
    model.set(&json!([LOCAL, B]), &ids([B])).unwrap();
    let saved = model.wire();
    for order in [
        Value::Null,
        json!({}),
        json!(LOCAL),
        json!([false]),
        json!([LOCAL, LOCAL]),
        json!([A]),
        json!([C]),
        json!(["Studio"]),
        json!(["/private"]),
    ] {
        assert!(
            model
                .set(&order, &ids([A, B, "Studio", "/private"]))
                .is_err()
        );
    }
    let mut incoming = device(C);
    incoming.set(&json!([LOCAL]), &[]).unwrap();
    let wire = incoming.wire();
    let good = &wire[0];
    let key = &saved[0][0];
    let writer = &saved[0][3];
    for bad in [
        Value::Null,
        json!({}),
        json!([]),
        json!([A, 0, 1, writer]),
        json!([LOCAL, 0, 1, writer]),
        json!([key, 0, 1, B]),
        json!([key, -1, 1, writer]),
        json!([key, 0.5, 1, writer]),
        json!([key, 0, null, writer]),
        json!([key, 0, 9007199254740991_u64, writer]),
        json!([key, 0, 1, writer, "private"]),
        good.clone(),
    ] {
        assert!(!model.merge(&json!([good, bad])));
    }
    for bad in [Value::Null, json!(""), json!({}), json!(vec![good; 1000])] {
        assert!(!model.merge(&bad));
    }
    assert_eq!(model.wire(), saved);
    assert_eq!(model.view(&ids([C, B])), [LOCAL, B, C]);
}

#[test]
fn full_histories_converge_to_the_same_bounded_state() {
    let mut one = device(A);
    let mut two = device(B);
    let hosts: Vec<_> = (0..512).map(|id| format!("{id:026x}")).collect();
    one.set(&json!(hosts[..256]), &hosts).unwrap();
    two.set(&json!(hosts[256..]), &hosts).unwrap();
    let older = one.wire();
    let newer = two.wire();
    assert_eq!(older.as_array().unwrap().len(), 256);
    assert_eq!(newer.as_array().unwrap().len(), 256);
    one.merge(&newer);
    two.merge(&older);
    assert_eq!(one.wire().as_array().unwrap().len(), 256);
    assert_eq!(two.wire(), one.wire());
    assert!(!one.merge(&older));
    assert!(!two.merge(&newer));
}
