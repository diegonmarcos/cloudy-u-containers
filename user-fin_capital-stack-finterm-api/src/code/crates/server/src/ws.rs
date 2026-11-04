//! WebSocket endpoint for DataHub topic subscriptions.
//!
//! Wire protocol (JSON text frames):
//!   client → `{"op":"subscribe","pattern":"market:quote:*"}`
//!   client → `{"op":"publish","topic":"market:quote:AAPL","value":{...}}`
//!   server → `{"event":"publish","topic":"…","value":{…}}`
//!
//! Multiple subscribes per connection are allowed. Dropping the WebSocket
//! cleanly unsubscribes everything (subscription RAII in DataHub).

use axum::extract::{
    ws::{Message, WebSocket},
    State, WebSocketUpgrade,
};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;

use crate::state::AppState;
use fincept_datahub::Subscription;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/v1/ws", get(upgrade))
}

async fn upgrade(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| serve(socket, state))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum ClientMsg {
    Subscribe {
        pattern: String,
    },
    Publish {
        topic: String,
        value: serde_json::Value,
    },
    Ping,
}

#[derive(Debug, Serialize)]
#[serde(tag = "event", rename_all = "lowercase")]
enum ServerMsg {
    Publish {
        topic: String,
        value: serde_json::Value,
    },
    Subscribed {
        pattern: String,
    },
    Pong,
    Error {
        message: String,
    },
}

async fn serve(socket: WebSocket, state: AppState) {
    let (mut sink, mut stream) = socket.split();

    // One outbound mpsc channel. Every pattern subscriber writes into it;
    // a single writer task drains it so we don't need Sender<WebSocket> split.
    let (tx, mut rx) = mpsc::unbounded_channel::<ServerMsg>();

    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let frame = match serde_json::to_string(&msg) {
                Ok(s) => s,
                Err(_) => continue,
            };
            if sink.send(Message::Text(frame.into())).await.is_err() {
                break;
            }
        }
    });

    // Keep subscriptions alive for the connection's lifetime.
    let mut subs: Vec<Subscription> = Vec::new();

    while let Some(Ok(frame)) = stream.next().await {
        let text = match frame {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue,
        };
        let Ok(msg) = serde_json::from_str::<ClientMsg>(&text) else {
            let _ = tx.send(ServerMsg::Error {
                message: "bad frame".into(),
            });
            continue;
        };

        match msg {
            ClientMsg::Subscribe { pattern } => {
                let tx_cb = tx.clone();
                let sub = state.hub.subscribe_pattern(&pattern, move |topic, val| {
                    let _ = tx_cb.send(ServerMsg::Publish {
                        topic: topic.to_string(),
                        value: (**val).clone(),
                    });
                });
                subs.push(sub);
                let _ = tx.send(ServerMsg::Subscribed { pattern });
            }
            ClientMsg::Publish { topic, value } => {
                let arc_val: fincept_datahub::Value = Arc::new(value);
                state.hub.publish(&topic, arc_val);
            }
            ClientMsg::Ping => {
                let _ = tx.send(ServerMsg::Pong);
            }
        }
    }

    // Drop subs + sender → writer task exits.
    drop(subs);
    drop(tx);
    let _ = writer.await;
}
