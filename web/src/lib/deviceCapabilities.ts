// Platform capability gates for the device UI.
//
// WebSSH runs an interactive PTY through the Linux operator stack. Windows
// edges only register host_files + restart_service, so the terminal entry
// must stay disabled instead of opening a page that can never connect.
export function supportsWebSSH(os?: string | null): boolean {
  return !(os ?? '').trim().toLowerCase().includes('windows');
}

// VNC rides the Windows-only loopback stream forwarder. Linux edges keep
// the interactive WebSSH path instead, so the entry point stays hidden for
// non-Windows rows rather than offering a session that cannot open.
export function supportsVNC(os?: string | null): boolean {
  return (os ?? '').trim().toLowerCase().includes('windows');
}

// RDP uses the Windows-only loopback forwarder (3389) and the IronRDP WASM
// client. Linux edges keep WebSSH, so the RDP entry stays hidden for them.
export function supportsRDP(os?: string | null): boolean {
  return (os ?? '').trim().toLowerCase().includes('windows');
}
