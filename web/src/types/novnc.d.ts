// Minimal typings for @novnc/novnc. The package ships untyped ES modules and
// 1.4.x has no main/module entry (only a browser field), so the page imports
// the RFB class from its ESM deep path.
declare module '@novnc/novnc/core/rfb.js' {
  export interface RFBCredentials {
    username?: string;
    password?: string;
    target?: string;
  }

  export interface RFBOptions {
    shared?: boolean;
    credentials?: RFBCredentials;
    repeaterID?: string;
    wsProtocols?: string[];
  }

  export interface RFBDisconnectDetail {
    clean: boolean;
  }

  export interface RFBSecurityFailureDetail {
    status?: number;
    reason?: string;
  }

  export interface RFBDesktopNameDetail {
    name: string;
  }

  export interface RFBClipboardDetail {
    text: string;
  }

  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      urlOrChannel: string | WebSocket | RTCDataChannel,
      options?: RFBOptions,
    );
    disconnect(): void;
    sendCredentials(credentials: RFBCredentials): void;
    sendCtrlAltDel(): void;
    clipboardPasteFrom(text: string): void;
    focus(options?: FocusOptions): void;
    blur(): void;
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    viewOnly: boolean;
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    addEventListener(
      type: 'connect' | 'credentialsrequired',
      listener: (ev: Event) => void,
    ): void;
    addEventListener(
      type: 'disconnect',
      listener: (ev: CustomEvent<RFBDisconnectDetail>) => void,
    ): void;
    addEventListener(
      type: 'securityfailure',
      listener: (ev: CustomEvent<RFBSecurityFailureDetail>) => void,
    ): void;
    addEventListener(
      type: 'desktopname',
      listener: (ev: CustomEvent<RFBDesktopNameDetail>) => void,
    ): void;
    addEventListener(
      type: 'clipboard',
      listener: (ev: CustomEvent<RFBClipboardDetail>) => void,
    ): void;
  }
}
