mod common;
#[path = "common/mem_store.rs"]
mod mem_store;

use std::sync::Arc;

use cosmog_lib::store::{ObjectStore, PutCond};

fn create() -> PutCond {
    PutCond { if_none_match: true, ..Default::default() }
}

fn matching(etag: &str) -> PutCond {
    PutCond { if_match: Some(etag.into()), ..Default::default() }
}

/// Save semantics a document editor relies on: create once, save on top of what it loaded,
/// and never overwrite a version it did not see.
async fn conditional_save_contract(store: &Arc<dyn ObjectStore>, bucket: &str) {
    let k = "notes/a.excalidraw";
    let put = |data: &'static [u8], cond: PutCond| {
        let store = store.clone();
        let bucket = bucket.to_owned();
        async move { store.put_object_bytes_if(&bucket, k, "application/json", data.to_vec(), Default::default(), cond).await }
    };

    let e1 = put(b"v1", create()).await.unwrap().expect("etag on create");
    assert_eq!(put(b"dup", create()).await.unwrap_err().code(), "conflict");
    assert_eq!(store.read_object_full(bucket, k).await.unwrap(), b"v1");

    let e2 = put(b"v2", matching(&e1)).await.unwrap().expect("etag on save");
    assert_ne!(e1, e2);

    // Another device saved v2; this editor still holds e1.
    assert_eq!(put(b"stale", matching(&e1)).await.unwrap_err().code(), "conflict");
    assert_eq!(store.read_object_full(bucket, k).await.unwrap(), b"v2");

    store.delete_object(bucket, k).await.unwrap();
    assert_eq!(put(b"after-delete", matching(&e2)).await.unwrap_err().code(), "conflict");
    assert!(store.head_object(bucket, k).await.unwrap_err().is_not_found());
}

#[tokio::test]
async fn conditional_save_head_fallback() {
    let mem = mem_store::MemStore::new();
    let store: Arc<dyn ObjectStore> = mem;
    conditional_save_contract(&store, "b").await;
}

#[tokio::test]
#[serial_test::serial]
async fn conditional_save_s3() {
    require_minio!();
    let store = common::make_store().await;
    let bucket = common::create_test_bucket(&store, "cosmog-plugdoc").await;
    conditional_save_contract(&store, &bucket).await;
    common::cleanup_bucket(&store, &bucket).await;
}

#[tokio::test]
async fn workspaces_crud_and_account_cascade() {
    let (db, _td, acct) = common::tmp_db_with_account().await;
    let ws = db.plugin_workspace_add("excalidraw", "Drawings", &acct, "bkt", "art/").await.unwrap();
    db.plugin_workspace_add("other", "X", &acct, "bkt", "").await.unwrap();

    let list = db.plugin_workspace_list("excalidraw").await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!((list[0].label.as_str(), list[0].bucket.as_str(), list[0].prefix.as_str()), ("Drawings", "bkt", "art/"));
    assert_eq!(db.plugin_workspace_get(&ws.id).await.unwrap().unwrap().account_id, acct);

    assert!(db.plugin_workspace_remove(&ws.id).await.unwrap());
    assert!(!db.plugin_workspace_remove(&ws.id).await.unwrap());
    assert!(db.plugin_workspace_list("excalidraw").await.unwrap().is_empty());

    db.delete_account(&acct).await.unwrap();
    assert!(db.plugin_workspace_list("other").await.unwrap().is_empty());
}
