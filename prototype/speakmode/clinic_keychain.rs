//! Only linked into the short-lived clinic helpers. Never re-enable UI in this process.
use speakmode_lib::{cloud::{self, CloudError}, core::ProviderConfig};

const UNAVAILABLE: &str = "clinic_keychain_access_required";

#[cfg(target_os = "macos")]
fn disable_interaction() -> bool {
    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        // macOS Security.framework: Boolean is an unsigned byte; OSStatus is int32_t.
        fn SecKeychainSetUserInteractionAllowed(allowed: u8) -> i32;
        fn SecKeychainGetUserInteractionAllowed(allowed: *mut u8) -> i32;
    }
    let mut allowed = 1;
    // This setting is local to our process. It does not change keychain contents or ACLs.
    // Keyring 3.6.3 uses the legacy SecKeychainFindGenericPassword API on macOS.
    unsafe {
        SecKeychainSetUserInteractionAllowed(0) == 0
            && SecKeychainGetUserInteractionAllowed(&mut allowed) == 0
            && allowed == 0
    }
}

#[cfg(not(target_os = "macos"))]
fn disable_interaction() -> bool { false }

fn guarded_read<T>(disable: impl FnOnce() -> bool, lookup: impl FnOnce() -> Result<T, CloudError>)
    -> Result<T, CloudError>
{
    let unavailable = || CloudError::new(UNAVAILABLE, "credentials", "门诊程序无法在无弹窗模式下读取钥匙串");
    if !disable() {
        return Err(unavailable());
    }
    // Upstream intentionally folds item-not-found and an access failure into one error.
    lookup().map_err(|_| unavailable())
}

pub fn read(config: &ProviderConfig) -> Result<String, CloudError> {
    guarded_read(disable_interaction, || cloud::credentials::read(config))
}

pub fn capabilities_requested(helper: &str) -> bool {
    if std::env::args().skip(1).eq(["--capabilities"]) {
        println!("{}", serde_json::json!({"helper":helper,"keychainInteraction":false}));
        true
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn failed_ui_guard_prevents_even_looking_up_any_item() {
        let e=guarded_read::<()>(||false,||panic!("credential lookup called")).unwrap_err();
        assert_eq!(e.code,UNAVAILABLE);
    }
    #[test] fn locked_or_missing_item_returns_one_sanitised_failure_and_never_retries() {
        let calls=std::cell::Cell::new(0);
        let e=guarded_read::<()>(||true,||{calls.set(calls.get()+1);Err(CloudError::new("key_required","","mock"))}).unwrap_err();
        assert_eq!(e.code,UNAVAILABLE);assert_eq!(calls.get(),1);
        assert_eq!(guarded_read(||true,||Ok("fixture")).unwrap(),"fixture");
    }
}
