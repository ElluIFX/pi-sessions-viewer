import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { basename, dirname } from "node:path";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("view", {
    description: "Open current session in Pi Sessions Viewer browser",
    handler: async (_args, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify("Cannot view an in-memory session.", "error");
        return;
      }

      const sessionId = `${basename(dirname(sessionFile))}/${basename(sessionFile)}`;
      const port = "27183";
      const url = `http://127.0.0.1:${port}/session?id=${encodeURIComponent(sessionId)}`;

      // Check if the viewer is actually running
      try {
        await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) });
      } catch {
        ctx.ui.notify(
          `Pi Sessions Viewer does not appear to be running on port ${port}. Try starting it: pi-sessions-viewer -o`,
          "error"
        );
        return;
      }

      // Open browser
      let cmd: string;
      let args: string[];
      switch (process.platform) {
        case "darwin":
          cmd = "open";
          args = [url];
          break;
        case "win32":
          cmd = "cmd";
          args = ["/c", "start", url];
          break;
        default:
          cmd = "xdg-open";
          args = [url];
          break;
      }

      try {
        await pi.exec(cmd, args);
        ctx.ui.notify(`Opened session viewer`, "success");
      } catch {
        ctx.ui.notify(`Failed to open browser. Visit ${url} manually.`, "warning");
      }
    },
  });
}
