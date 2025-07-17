// ─────────────────────────────────────────────────────────────────────────────
// main.js — Electron + FFmpeg two-pass encoding, reorganized for clarity
// ─────────────────────────────────────────────────────────────────────────────

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Notification,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile, spawn } = require("child_process");
const checkDiskSpace = require("check-disk-space").default;

// ─────────────────────────────────────────────────────────────────────────────
// Globals
// ─────────────────────────────────────────────────────────────────────────────

let mainWindow;
let activeProcess = null;
let totalDuration = null;
let currentEncoding = null;
let isCanceled = false;
let passLogBase = null;
let encodingDir = null;

// Holds the calculated settings from analyze-file → start-encoding
const encodingSettings = {};

// Path to FFprobe/FFmpeg shipped in your app bundle
const isDev = !app.isPackaged;
// use ffmpeg-static (exports the exe path) in dev,
// and your extraResources copy in prod
const ffmpegPath = isDev
  ? require("ffmpeg-static")
  : path.join(process.resourcesPath, "ffmpeg", "ffmpeg.exe");

// ffprobe-static ships an object with a `.path` property
const ffprobePath = isDev
  ? require("ffprobe-static").path
  : path.join(process.resourcesPath, "ffmpeg", "ffprobe.exe");

// ─────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Kill a process tree (Windows or POSIX).
 */
function killProcessTree(pid) {
  if (!pid) return Promise.resolve();
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", pid, "/t", "/f"]);
      killer.on("close", () => resolve());
      // ensure kill if taskkill hangs
      setTimeout(() => {
        killer.kill("SIGKILL");
        resolve();
      }, 2000);
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
      resolve();
    }
  });
}

/**
 * Called whenever we start a new encoding or cancel:
 * stops any in-flight FFmpeg, rejects promise, resets flags.
 */
async function cleanupEncoding() {
  console.log("[main] cleanupEncoding called");

  isCanceled = true;

  if (activeProcess?.pid) {
    console.log("[main] Killing process tree:", activeProcess.pid);
    await killProcessTree(activeProcess.pid);
  }

  if (currentEncoding) {
    currentEncoding.reject(new Error("Encoding canceled"));
    currentEncoding = null;
  }

  activeProcess = null;
  totalDuration = null;

  // small delay so processes wind down
  await new Promise((r) => setTimeout(r, 500));

  // Cleanup log files if paths are available
  if (passLogBase && encodingDir) {
    console.log("[main] Deleting temp files from:", encodingDir, passLogBase);
    await deletePassLogFiles(encodingDir, passLogBase);
  } else {
    console.warn(
      "[main] ⚠ Skipping log cleanup—missing encodingDir or passLogBase",
    );
  }

  // Optional: clear them for safety
  passLogBase = null;
  encodingDir = null;
}

/**
 * Remove all temporary two-pass log files.
 */
async function deletePassLogFiles(dir, statsBase) {
  console.log("[main] Attempting to delete temp files for:", statsBase);

  const tempFiles = [
    `${statsBase}`,
    `${statsBase}.log`,
    `${statsBase}.log.temp`,
    `${statsBase}.log.cutree`,
    `${statsBase}.log.cutree.temp`,
    `${statsBase}-0`,
    `${statsBase}-0.log`,
    `${statsBase}-0.log.mbtree`,
    `${statsBase}-0.log.mbtree.temp`,
  ];

  const deletionPromises = tempFiles.map((tempPath) => {
    const fullPath = path.join(dir, tempPath);
    return fs.promises.unlink(fullPath).catch((err) => {
      if (err.code !== "ENOENT") {
        console.warn(`[main] Could not delete temp file: ${fullPath}`, err);
      }
    });
  });

  await Promise.allSettled(deletionPromises);
}

/**
 * Convert "HH:MM:SS.ss" to seconds (float).
 */
function parseTime(str) {
  const [h, m, s] = str.split(":").map(parseFloat);
  return h * 3600 + m * 60 + s;
}

/**
 * Check if there's enough free space for the output file.
 */
async function ensureEnoughDisk(dir, requiredBytes) {
  const { free } = await checkDiskSpace(dir);
  if (free < requiredBytes) {
    throw new Error(
      `Insufficient disk space. Need ${Math.ceil(requiredBytes / 1024 / 1024)} MB free.`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FFprobe + Settings Calculation
// ─────────────────────────────────────────────────────────────────────────────

ipcMain.handle("open-file-dialog", async () => {
  const res = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "Videos", extensions: ["mp4", "mkv", "mov", "avi"] }],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle("analyze-file", async (_, inputPath) => {
  try {
    const inputSizeBytes = fs.statSync(inputPath).size;

    // probe for duration & resolution
    const ffprobeArgs = [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height:format=duration",
      "-of",
      "json",
      inputPath,
    ];
    const { stdout } = await new Promise((res, rej) =>
      execFile(ffprobePath, ffprobeArgs, (e, so) =>
        e ? rej(e) : res({ stdout: so }),
      ),
    );
    const probe = JSON.parse(stdout);
    const durationSec = parseFloat(probe.format.duration);
    const width = probe.streams[0].width;
    const height = probe.streams[0].height;

    // compute bitrates, filter + estimate
    const settings = calculateTargetBitrate({
      inputSizeBytes,
      durationSec,
      resolution: { width, height },
    });
    encodingSettings[inputPath] = settings;

    // build UI-friendly estimate
    const rawMB = settings.targetSizeBytes / (1024 * 1024); // float
    const estimatedSizeMB = Math.ceil(rawMB); // display-friendly
    const estimatedOutputBytes = estimatedSizeMB * 1024 * 1024;

    // warn if the space saved is less than 10MB
    const savedBytes = inputSizeBytes - estimatedOutputBytes;
    const savedMB = savedBytes / (1024 * 1024);

    const warning =
      savedMB < 10
        ? `This video is already highly compressed. This will only reduce the file by ~${savedMB.toFixed(1)} MB.`
        : null;

    // final output path
    const baseName = path.basename(inputPath, path.extname(inputPath));
    const outputFile = path.join(
      path.dirname(inputPath),
      `${baseName}_SMALL.mp4`,
    );

    if (fs.existsSync(outputFile)) {
      return {
        error: `A file named “${path.basename(outputFile)}” already exists in this folder.`,
      };
    }

    return { ...settings, estimatedSizeMB, warning, outputFile };
  } catch (err) {
    console.error("[main] analyze-file error:", err);
    return { error: "Failed to analyze video." };
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Two-Pass Encoding Workflow
// ─────────────────────────────────────────────────────────────────────────────

ipcMain.on("start-encoding", async (event, inputPath) => {
  // 1) Make sure we have settings
  if (!encodingSettings[inputPath]) {
    return event.sender.send("encoding-error", "Missing encoding parameters");
  }

  // 2) Build file names & paths
  const settings = encodingSettings[inputPath];
  const dir = path.dirname(inputPath);
  const baseName = path.basename(inputPath, path.extname(inputPath));
  const safeBase = baseName.replace(/[^a-zA-Z0-9_-]/g, "_");
  const statsBase = `${safeBase}_ffmpeg2pass`;
  const nullSink = process.platform === "win32" ? "NUL" : "/dev/null";

  // 3) Kill any prior runs _first_
  await cleanupEncoding();
  isCanceled = false;

  // 4) Now assign the globals so they stick around until we cancel
  passLogBase = statsBase;
  encodingDir = dir;

  // 5) Disk‐space check
  try {
    await ensureEnoughDisk(dir, settings.targetSizeBytes * 1.1);
  } catch (err) {
    return event.sender.send("encoding-error", err.message);
  }

  // 6) Launch the two‐pass encode
  try {
    const result = await twoPassEncode(
      inputPath,
      dir,
      baseName,
      statsBase,
      nullSink,
      settings,
    );
    // Show notification if unfocused
    if (!mainWindow.isFocused()) {
      const notification = new Notification({
        title: "Encoding Complete",
        body: `Your file "${baseName}_SMALL.mp4" is ready.`,
      });

      notification.on("click", () => {
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.show();
        mainWindow.focus();
      });

      notification.show();
    }
    currentEncoding = null;
    console.log("[main] Encoding complete:", result);
    mainWindow.webContents.send("encoding-complete", result);
  } catch (err) {
    console.error("[main] Encoding error:", err);
    currentEncoding = null;
    const channel = err.message.includes("canceled")
      ? "encoding-cancelled"
      : "encoding-error";
    mainWindow.webContents.send(channel, err.message);
  }
});

/**
 * Encapsulates the two-pass cycle as a Promise.
 */
function twoPassEncode(
  inputPath,
  dir,
  baseName,
  statsBase,
  nullSink,
  settings,
) {
  const { videoKbps, audioBitrate, scaleFilter } = settings;

  // build args for pass 1 or 2
  const makeArgs = (pass) => {
    const common = [
      "-y",
      "-i",
      inputPath,
      "-fflags",
      "+genpts",
      "-avoid_negative_ts",
      "make_zero",
      "-vf",
      scaleFilter,
      "-map",
      "0:v:0",
      "-c:v",
      "libx265",
      "-preset",
      "ultrafast",
      "-b:v",
      `${videoKbps}k`,
      "-x265-params",
      `pools=6:pass=${pass}:stats=${statsBase}.log:no-sao=1`,
      "-passlogfile",
      statsBase,
    ];

    if (pass === 1) {
      return [...common, "-an", "-pass", "1", "-f", "null", nullSink];
    } else {
      return [
        ...common,
        "-map",
        "0:a:0",
        "-c:a",
        "aac",
        "-b:a",
        `${audioBitrate}k`,
        "-ar",
        "48000",
        "-ac",
        "2",
        "-pass",
        "2",
        path.join(dir, `${baseName}_SMALL.mp4`),
      ];
    }
  };

  return new Promise((resolve, reject) => {
    currentEncoding = { resolve, reject };
    totalDuration = null;

    function runPass(pass) {
      // 1) Bail early on cancel
      if (isCanceled) {
        deletePassLogFiles(dir, statsBase);
        return reject(new Error("Encoding canceled"));
      }

      // 2) Safely build your args
      let args;
      try {
        args = makeArgs(pass);
      } catch (err) {
        deletePassLogFiles(dir, statsBase);
        return reject(err);
      }

      // 3) Kick off FFmpeg
      console.log(`[main] Starting pass ${pass}`, args.join(" "));
      activeProcess = spawn(ffmpegPath, args, {
        cwd: dir,
        detached: process.platform !== "win32",
      });
      const thisProc = activeProcess;

      // track progress from stderr
      activeProcess.stderr.on("data", (data) => {
        if (isCanceled || thisProc !== activeProcess) return;

        const line = data.toString();
        console.log(`[FFmpeg P${pass}]`, line.trim());

        if (!totalDuration) {
          const m = line.match(/Duration:\s*([\d:.]+)/);
          if (m) totalDuration = parseTime(m[1]);
        }
        if (totalDuration) {
          const tm = line.match(/time=([\d:.]+)/);
          if (tm) {
            const elapsed = parseTime(tm[1]);
            const pct = Math.min(
              100,
              Math.round((elapsed / totalDuration) * 100),
            );
            mainWindow.webContents.send("encoding-progress", {
              percent: pct,
              pass,
            });
          }
        }
      });

      activeProcess.on("close", (code) => {
        if (thisProc !== activeProcess) return;
        activeProcess = null;

        // error or cancel → cleanup & reject
        if (isCanceled || code !== 0) {
          deletePassLogFiles(dir, statsBase);
          const msg = isCanceled
            ? "Encoding canceled"
            : `FFmpeg pass ${pass} failed: ${code}`;
          return reject(new Error(msg));
        }

        // success path
        if (pass === 1) {
          runPass(2);
        } else {
          deletePassLogFiles(dir, statsBase);
          resolve({
            success: true,
            outputFile: path.join(dir, `${baseName}_SMALL.mp4`),
          });
        }
      });

      activeProcess.on("error", (err) => {
        if (thisProc !== activeProcess) return;
        activeProcess = null;
        if (!isCanceled) reject(err);
      });
    }

    runPass(1);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancel & Show-In-Folder Handlers
// ─────────────────────────────────────────────────────────────────────────────

ipcMain.on("cancel-encoding", async () => {
  console.log("[main] Cancel requested");
  await cleanupEncoding();
  mainWindow.webContents.send("encoding-cancelled");
});

ipcMain.on("show-in-folder", (_, filePath) => {
  if (filePath) shell.showItemInFolder(filePath);
});

// ─────────────────────────────────────────────────────────────────────────────
// Bitrate Calculator (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

function calculateTargetBitrate({
  inputSizeBytes,
  durationSec,
  resolution = { width: 1920, height: 1080 },
}) {
  // 1) Base ratio by file size
  const sizeThresholds = [
    { bytes: 1_073_741_824, ratio: 0.1 },
    { bytes: 536_870_912, ratio: 0.12 },
  ];
  let baseRatio = 0.15;
  for (const t of sizeThresholds) {
    if (inputSizeBytes > t.bytes) {
      baseRatio = t.ratio;
      break;
    }
  }

  // 2) Duration boost
  const mins = durationSec / 60;
  let boost = mins > 45 ? 0.05 : mins < 20 ? 0.02 + (1 - mins / 20) * 0.03 : 0;

  const retentionRatio = Math.min(0.2, baseRatio + boost);

  // 3) Total kbps
  const totalKbps = Math.round(
    (inputSizeBytes * retentionRatio * 8) / durationSec / 1000,
  );

  // 4) Audio/video split
  const audioBitrate = durationSec < 1800 ? 96 : 64;
  const minVideoKbps = 850;
  const videoKbps = Math.max(minVideoKbps, totalKbps - audioBitrate);

  // 5) Scale filter
  const pixels = resolution.width * resolution.height;
  const scaleFilter = pixels > 1280 * 720 ? "scale=1080:720,fps=25" : "fps=25";

  // 6) Final size estimate
  const targetSizeBytes = Math.round(
    ((videoKbps + audioBitrate) * durationSec * 1000) / 8,
  );

  return { videoKbps, audioBitrate, totalKbps, targetSizeBytes, scaleFilter };
}

// ─────────────────────────────────────────────────────────────────────────────
// App Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 620,
    height: 520,
    icon: path.join(__dirname, "assets", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "src", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join("src", "index.html"));
  mainWindow.setTitle("DrinkMe");
}

app.whenReady().then(createWindow);
