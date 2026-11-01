// JSON contracts shared by the console server and the bundled browser client.
export type ChannelType = "http" | "forward-ws" | "reverse-ws" | "reverse-http";
export interface ChannelInput {
  name: string;
  type: ChannelType;
  enabled: boolean;
  host: string;
  port: number;
  url: string;
  accessToken: string;
  secret: string;
  timeoutMs: number;
  publicBaseUrl: string;
}
export interface ConsoleChannel extends ChannelInput {
  id: string;
  status: { state: string; clients?: number; error?: string };
}
export interface ConsoleLogin {
  id: string;
  state:
    | "waiting"
    | "scanned"
    | "verifying"
    | "choose_trust"
    | "confirmed"
    | "saved"
    | "expired"
    | "refused"
    | "error";
  expiresAt: number;
  message: string;
  verification?: { smsAvailable: boolean; resendAt: number };
}
export interface ConsoleStatus {
  startedAt: number;
  account: { loggedIn: boolean; id?: string; online?: boolean; good?: boolean };
  browser: "ready" | "error" | "starting";
  error?: string;
  channels: ConsoleChannel[];
  activity: Array<{ time: string; message: string }>;
  login?: ConsoleLogin;
}
