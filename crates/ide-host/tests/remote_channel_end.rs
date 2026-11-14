//! A streaming argument of a remote command ends with a `channel_end` notification once the
//! server can no longer send on it, so the desktop can release what relays it; a stream that
//! outlives its command's reply ends only when its last sender goes.

use ide_core::NullSink;
use ide_host::ops::Emit;
use ide_host::rpc::{self, ChannelEndMessage, ChannelMessage, Dispatcher, Invoke};
use ide_host::{Host, HostConfig};
use ide_jsonrpc::{Handler, Peer};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

#[derive(Debug, PartialEq)]
enum Seen {
    Value(u64, Value),
    End(u64),
}

struct Recorder(Mutex<Sender<Seen>>);

impl Handler for Recorder {
    fn on_notification(&self, method: &str, params: Value) {
        let seen = match method {
            "channel" => {
                let m: ChannelMessage = serde_json::from_value(params).unwrap();
                Seen::Value(m.id, m.data)
            }
            "channel_end" => Seen::End(serde_json::from_value::<ChannelEndMessage>(params).unwrap().id),
            _ => return,
        };
        let _ = self.0.lock().send(seen);
    }
    fn on_request(&self, method: &str, _: Value) -> Result<Value, (i64, String)> {
        Err((ide_jsonrpc::codes::METHOD_NOT_FOUND, method.to_owned()))
    }
}

type Held = Arc<Mutex<Option<Emit<u32>>>>;

fn host(tmp: &tempfile::TempDir) -> Arc<Host> {
    let root = tmp.path().join("project");
    std::fs::create_dir(&root).unwrap();
    let host = Arc::new(Host::new(HostConfig {
        config_dir: tmp.path().join("config"),
        data_dir: tmp.path().join("data"),
        local_data_dir: tmp.path().join("data"),
        languages: Arc::new(ide_language::LanguageRegistry::load(None).unwrap()),
        syntax: Arc::default(),
        sink_for: Box::new(|_| Arc::new(NullSink)),
        owner: |w| w,
        runtime: tokio::runtime::Handle::current(),
        project_environment: false,
    }));
    host.trust.decide(&root, true, false).unwrap();
    host.open_project("main", &root).unwrap();
    host
}

async fn serve(host: Arc<Host>, held: Held) -> (Peer, Receiver<Seen>) {
    let mut d = Dispatcher::default();
    d.add("finite", |c| async move {
        let emit = c.channel::<u32>("onEvent")?;
        let again = c.channel::<u32>("onEvent")?;
        emit(1);
        again(2);
        Ok(())
    })
    .add("ignores", |_| async move { Ok(()) })
    .add("fails", |c| async move {
        let _emit = c.channel::<u32>("onEvent")?;
        Err::<(), _>(ide_core::IdeError::invalid("no"))
    })
    .add("stream", move |c| {
        let held = held.clone();
        async move {
            let emit = c.channel::<u32>("onEvent")?;
            emit(1);
            *held.lock() = Some(emit);
            Ok(())
        }
    });
    let (client_io, server_io) = tokio::io::duplex(1 << 20);
    let (sr, sw) = tokio::io::split(server_io);
    tokio::spawn(rpc::serve(host, d, Arc::new(OnceLock::new()), sr, sw));
    let (tx, rx) = channel();
    let (cr, cw) = tokio::io::split(client_io);
    let peer = Peer::connect(cr, cw, Arc::new(Recorder(Mutex::new(tx))));
    (peer, rx)
}

async fn invoke(peer: &Peer, cmd: &str, channel: u64) -> Result<Value, ide_core::IdeError> {
    let call = Invoke { window: "main".into(), cmd: cmd.into(), args: json!({ "onEvent": { "$channel": channel } }) };
    peer.request::<_, Value>("invoke", call, None).await.map_err(rpc::error_from_reply)
}

fn drain(rx: &Receiver<Seen>) -> Vec<Seen> {
    rx.try_iter().collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_finished_command_ends_its_channels_after_their_values() {
    let tmp = tempfile::tempdir().unwrap();
    let (peer, rx) = serve(host(&tmp), Held::default()).await;
    invoke(&peer, "finite", 7).await.unwrap();
    assert_eq!(drain(&rx), [Seen::Value(7, json!(1)), Seen::Value(7, json!(2)), Seen::End(7)]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_channel_ends_however_the_command_does() {
    let tmp = tempfile::tempdir().unwrap();
    let (peer, rx) = serve(host(&tmp), Held::default()).await;
    invoke(&peer, "ignores", 1).await.unwrap();
    assert_eq!(drain(&rx), [Seen::End(1)]);
    invoke(&peer, "fails", 2).await.unwrap_err();
    assert_eq!(drain(&rx), [Seen::End(2)]);
    invoke(&peer, "missing", 3).await.unwrap_err();
    assert_eq!(drain(&rx), [Seen::End(3)]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stream_ends_when_its_last_sender_goes() {
    let tmp = tempfile::tempdir().unwrap();
    let held = Held::default();
    let (peer, rx) = serve(host(&tmp), held.clone()).await;
    invoke(&peer, "stream", 9).await.unwrap();
    assert_eq!(drain(&rx), [Seen::Value(9, json!(1))]);
    let emit = held.lock().clone().unwrap();
    emit(2);
    drop(emit);
    assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), Seen::Value(9, json!(2)));
    assert!(rx.recv_timeout(Duration::from_millis(200)).is_err(), "still held: no end");
    held.lock().take();
    assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), Seen::End(9));
}
