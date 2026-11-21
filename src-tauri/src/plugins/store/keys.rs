//! Signature check for store packages. The private key lives only in the cosmog-plugins CI secret;
//! the app trusts the public keys below and nothing else.

use aws_lc_rs::digest::{digest, SHA256};
use aws_lc_rs::signature::{UnparsedPublicKey, ED25519};

use crate::error::{AppError, AppResult};

pub struct TrustedKey {
    pub id: &'static str,
    pub public: [u8; 32],
}

/// Rotate by adding the new key, releasing, then dropping the old one in a later app version.
pub const TRUSTED_KEYS: &[TrustedKey] = &[
    // 2026-11-21. Private half: cosmog-plugins secret COSMOG_SIGNING_KEY.
    TrustedKey {
        id: "cosmog-2026-1",
        public: [
            60, 203, 140, 195, 76, 239, 137, 232, 90, 245, 67, 12, 202, 52, 114, 77, 22, 64, 130, 240, 106, 25, 235,
            151, 156, 181, 188, 184, 20, 39, 119, 86,
        ],
    },
];

/// What CI signs. Binds the archive hash to id and version, so a genuine package can't be
/// served as another plugin or another version.
pub fn statement(id: &str, version: &str, sha256_hex: &str) -> String {
    format!("cosmog-plugin-v1\n{id}\n{version}\n{sha256_hex}\n")
}

pub fn sha256_hex(data: &[u8]) -> String {
    digest(&SHA256, data).as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

pub fn verify(keys: &[TrustedKey], key_id: &str, sig: &[u8], msg: &[u8]) -> AppResult<()> {
    let key = keys
        .iter()
        .find(|k| k.id == key_id)
        .ok_or_else(|| AppError::InvalidInput(format!("package signed with unknown key {key_id:?}")))?;
    UnparsedPublicKey::new(&ED25519, key.public)
        .verify(msg, sig)
        .map_err(|_| AppError::InvalidInput("package signature does not match".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_lc_rs::signature::{Ed25519KeyPair, KeyPair};

    fn pair() -> (Ed25519KeyPair, [u8; 32]) {
        let kp = Ed25519KeyPair::generate().unwrap();
        let public: [u8; 32] = kp.public_key().as_ref().try_into().unwrap();
        (kp, public)
    }

    #[test]
    fn sha256_known_vector() {
        assert_eq!(sha256_hex(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    #[test]
    fn verify_accepts_only_the_signed_statement_and_key() {
        let (kp, public) = pair();
        let keys = [TrustedKey { id: "k1", public }];
        let msg = statement("excalidraw", "1.0.0", "aa");
        let sig = kp.sign(msg.as_bytes());
        verify(&keys, "k1", sig.as_ref(), msg.as_bytes()).unwrap();
        // Same signature, other version or plugin: refused.
        let other = statement("excalidraw", "1.0.1", "aa");
        assert!(verify(&keys, "k1", sig.as_ref(), other.as_bytes()).is_err());
        assert!(verify(&keys, "k2", sig.as_ref(), msg.as_bytes()).is_err());
        let (_, stranger) = pair();
        let wrong = [TrustedKey { id: "k1", public: stranger }];
        assert!(verify(&wrong, "k1", sig.as_ref(), msg.as_bytes()).is_err());
    }
}
