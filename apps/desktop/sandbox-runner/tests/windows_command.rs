#![cfg(windows)]

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::current_dir()
            .unwrap()
            .join("target")
            .join(format!("windows-command-{}-{nonce}", std::process::id()));
        fs::create_dir_all(path.join("workspace/sub")).unwrap();
        fs::write(path.join("outside.txt"), "private").unwrap();
        fs::write(path.join("workspace/sub/value.cjs"), "module.exports = 42;").unwrap();
        Self(path)
    }

    fn run(&self, args: &[&str]) -> Output {
        let node = Command::new("node")
            .args(["-p", "process.execPath"])
            .output()
            .unwrap();
        assert!(node.status.success());
        Command::new(env!("CARGO_BIN_EXE_sprint-coder-sandbox-runner"))
            .args(["--exec", "workspace-write"])
            .arg(self.0.join("workspace"))
            .arg("--protected-home")
            .arg(std::env::var_os("USERPROFILE").unwrap())
            .arg("--")
            .arg(String::from_utf8(node.stdout).unwrap().trim())
            .args(args)
            .current_dir(self.0.join("workspace/sub"))
            .stdin(Stdio::null())
            .output()
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // This unique directory was created by this fixture beneath the crate's target folder.
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn preserves_the_requested_subdirectory() {
    let fixture = Fixture::new();
    let output = fixture.run(&["-e", "console.log(process.cwd())"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        PathBuf::from(String::from_utf8(output.stdout).unwrap().trim()),
        fixture.0.join("workspace/sub")
    );
}

#[test]
fn preserves_sandbox_boundary_when_using_nested_cwd() {
    let fixture = Fixture::new();
    let script = format!(
        "const fs=require('node:fs'),a=require('node:assert/strict');a.equal(require({}),42);a.throws(()=>fs.readFileSync({}));a.throws(()=>fs.readdirSync({}));a.throws(()=>fs.writeFileSync({},'changed'));console.log('NODE_BOUNDARY_OK');",
        serde_json::to_string(&fixture.0.join("workspace/sub/value.cjs")).unwrap(),
        serde_json::to_string(&fixture.0.join("outside.txt")).unwrap(),
        serde_json::to_string(&fixture.0).unwrap(),
        serde_json::to_string(&fixture.0.join("outside.txt")).unwrap(),
    );
    // AppContainer cannot inspect the drive root on every machine. These explicit Node
    // options avoid that runtime dependency; the test is about the sandbox boundary.
    let output = fixture.run(&[
        "--preserve-symlinks",
        "--preserve-symlinks-main",
        "-e",
        &script,
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        "NODE_BOUNDARY_OK"
    );
    assert_eq!(
        fs::read_to_string(fixture.0.join("outside.txt")).unwrap(),
        "private"
    );
}

#[test]
fn sandbox_probe_keeps_its_explicit_workspace() {
    let output = Command::new(env!("CARGO_BIN_EXE_sprint-coder-sandbox-runner"))
        .arg("--probe-json")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(output.status.success());
    let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["available"], true, "{result}");
}
