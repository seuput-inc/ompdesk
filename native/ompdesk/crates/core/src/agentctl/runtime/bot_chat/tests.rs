use super::*;
use crate::agentctl::journal::bots::FolderMove;
use crate::agentctl::runtime::tests::rig;
use crate::agentctl::service::Files;

const ADA: &str = "bot-aaaaaaaaaaaa";
const OTHER: &str = "bot-bbbbbbbbbbbb";

fn request(port: u64, id: &str, path: Option<&str>) -> Result<Value, Fault> {
    let params = json!({ "port": port, "botId": id, "sessionPath": path });
    launch(serde_json::from_value(params).unwrap())
}

fn header(path: &str, cwd: &str, id: &str) {
    let head = json!({ "type": "session", "id": id, "cwd": cwd });
    std::fs::write(path, format!("{{\"type\":\"title\"}}\n{head}\n")).unwrap();
}

#[test]
fn a_missing_path_or_renderer_launch_options_do_not_request_a_new_bot_chat() {
    for params in [
        json!({ "port": 1, "botId": ADA }),
        json!({ "port": 1, "botId": ADA, "sessionPath": null, "cwd": "/another" }),
    ] {
        assert!(serde_json::from_value::<Launch>(params).is_err());
    }
}

#[tokio::test]
async fn local_launch_pins_only_its_stock_pair_and_keeps_the_delivery_home() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    let names = ["legacy.jsonl", "new.jsonl", "other.jsonl"]
        .map(|name| dir.path().join(name).to_str().unwrap().to_owned());
    let [old, new, foreign] = names.each_ref().map(String::as_str);
    let files = || Files {
        bots: Some(dir.path().join("bots.json")),
        ..Files::default()
    };
    let (control, _, _) = rig(7_601, json!({}), files(), |_, _| Ok(Value::Null));
    for (id, folder) in [(ADA, cwd), (OTHER, "elsewhere")] {
        control.bots().add(BotRecord {
            id: id.into(),
            name: if id == ADA { "Ada" } else { "Other" }.into(),
            folder: folder.into(),
            ..BotRecord::default()
        });
    }
    header(old, cwd, "old-stock");
    header(foreign, "elsewhere", "other-stock");
    control.bots().observe(cwd, old);
    control.bots().observe("elsewhere", foreign);
    let answer = request(7_601, ADA, None).unwrap();
    let port = answer["botChatPort"].as_u64().unwrap();
    assert_eq!(
        answer,
        json!({"cwd": cwd, "sessionPath": null, "botId": ADA, "botChatPort": port})
    );
    assert_eq!(
        request(7_601, ADA, Some(old)).unwrap()["botId"],
        Value::Null
    );
    assert!(bot_chat_authority(port, ADA, Some(old)).is_err());
    control.bots().change(ADA, |bot| bot.paused = true);
    assert!(request(7_601, ADA, Some(old)).unwrap()["botId"].is_null());
    assert!(request(7_601, ADA, None).is_err());
    control.bots().change(ADA, |bot| bot.paused = false);
    assert!(request(7_601, ADA, Some(foreign)).is_err());
    assert!(request(7_601, ADA, Some(new)).is_err());
    for id in ["Ada", " bot-aaaaaaaaaaaa", "bot-cccccccccccc"] {
        assert!(request(7_601, id, None).is_err());
    }
    let prior = bot_chat_prior_paths(port, ADA).unwrap();
    assert!(prior.contains(old) && prior.contains(foreign) && !prior.contains(new));
    assert!(!observe_bot_chat(port, ADA, cwd, None, new, "stock-one"));
    header(new, cwd, "stock-one");
    // The generic activity can arrive before the newly launched omp's own correlated state reply.
    control.bots().observe(cwd, new);
    assert!(request(7_601, ADA, Some(new)).unwrap()["botId"].is_null());
    assert!(!observe_bot_chat(
        port,
        ADA,
        cwd,
        None,
        foreign,
        "other-stock"
    ));
    assert!(!observe_bot_chat(port, ADA, cwd, None, new, "forged"));
    assert!(observe_bot_chat(port, ADA, cwd, None, new, "stock-one"));
    assert!(bot_chat_matches(port, ADA, cwd, Some((new, "stock-one"))));
    assert!(!bot_chat_matches(
        port,
        OTHER,
        cwd,
        Some((new, "stock-one"))
    ));
    let local = control.bots_state();
    assert_eq!(local["bots"][0]["home"], old);
    assert_eq!(local["bots"][0]["chatHome"], new);
    assert!(local["bots"][0].get("chatPins").is_none());
    let shared = control.bots_share();
    assert!(shared["state"]["bots"][0].get("chatHome").is_none());
    assert!(shared["state"]["bots"][0].get("chatPins").is_none());
    control.host.port().close();
    assert!(!bot_chat_matches(port, ADA, cwd, None));

    // Main reuses its control port on reconnect; the old incarnation cannot address the new runtime.
    let (restored, _, _) = rig(7_601, json!({}), files(), |_, _| Ok(Value::Null));
    let answer = request(7_601, ADA, Some(new)).unwrap();
    assert!(!bot_chat_matches(port, ADA, cwd, None));
    let reopened = answer["botChatPort"].as_u64().unwrap();
    assert_eq!(answer["botId"], ADA);
    assert_eq!(answer["sessionPath"], new);
    assert_eq!(
        bot_chat_authority(reopened, ADA, Some(new)).unwrap(),
        (cwd.to_owned(), Some("stock-one".to_owned()))
    );
    assert!(observe_bot_chat(
        reopened,
        ADA,
        cwd,
        Some(new),
        new,
        "stock-one"
    ));
    assert!(!observe_bot_chat(
        reopened,
        ADA,
        cwd,
        Some(new),
        new,
        "other"
    ));
    assert!(!observe_bot_chat(
        reopened,
        ADA,
        cwd,
        Some(new),
        old,
        "stock-one"
    ));
    header(new, cwd, "replacement");
    assert!(request(7_601, ADA, Some(new)).is_err());
    assert!(bot_chat_authority(reopened, ADA, Some(new)).is_err());
    std::fs::remove_file(new).unwrap();
    assert!(request(7_601, ADA, Some(new)).is_err());
    assert!(bot_chat_authority(reopened, ADA, Some(new)).is_err());
    restored.host.port().close();
}

#[tokio::test]
async fn paused_moving_deleted_and_removed_bots_do_not_keep_a_grant() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    let path = dir.path().join("saved.jsonl");
    let path = path.to_str().unwrap();
    let (control, _, _) = rig(7_603, json!({}), Files::default(), |_, _| Ok(Value::Null));
    control.bots().add(BotRecord {
        id: ADA.into(),
        name: "Ada".into(),
        folder: cwd.into(),
        ..BotRecord::default()
    });
    let port = request(7_603, ADA, None).unwrap()["botChatPort"]
        .as_u64()
        .unwrap();
    control.bots().change(ADA, |bot| bot.paused = true);
    assert!(request(7_603, ADA, None).is_err());
    assert!(!bot_chat_matches(port, ADA, cwd, None));
    control.bots().change(ADA, |bot| {
        bot.paused = false;
        bot.moving = Some(FolderMove::default());
    });
    assert!(bot_chat_authority(port, ADA, None).is_err());
    control.bots().change(ADA, |bot| bot.moving = None);
    header(path, cwd, "deleted-stock");
    assert!(observe_bot_chat(
        port,
        ADA,
        cwd,
        None,
        path,
        "deleted-stock"
    ));
    let state = json!({"deleted":{"byId":{"deleted-stock":1}}});
    crate::ports::apply_state(control.host.port(), 1, &state.to_string()).unwrap();
    assert!(request(7_603, ADA, Some(path)).is_err());
    assert!(!bot_chat_matches(
        port,
        ADA,
        cwd,
        Some((path, "deleted-stock"))
    ));
    let state = json!({"deleted":{"byPath":[{"path":path, "at":2}]}});
    crate::ports::apply_state(control.host.port(), 2, &state.to_string()).unwrap();
    assert!(request(7_603, ADA, Some(path)).is_err());
    assert!(!bot_chat_matches(
        port,
        ADA,
        cwd,
        Some((path, "deleted-stock"))
    ));
    control.bots().remove(ADA);
    assert!(request(7_603, ADA, None).is_err());
    assert!(!bot_chat_matches(port, ADA, cwd, None));
    control.host.port().close();
}
