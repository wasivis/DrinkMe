// Destructure the exposed API
const {
  openFileDialog,
  startEncoding,
  cancelEncoding,
  onEncodingProgress,
  onEncodingComplete,
  onEncodingCancelled,
  onEncodingError,
} = window.electronAPI;

// DOM Elements
const fileBtn = document.getElementById("fileBtn");
const encodeBtn = document.getElementById("encodeBtn");
const cancelBtn = document.getElementById("cancelBtn");
const showFolderBtn = document.getElementById("showFolderBtn");
const progressBar = document.getElementById("progressBar");
const passNumberText = document.getElementById("passNumberText");
const progressContainer = document.querySelector(".progress-container");
const progressHeader = document.getElementById("progressHeader");
const statusBox = document.getElementById("statusBox");
const spinner = document.getElementById("loadingSpinner");
const spinnerText = document.getElementById("spinnerText");
const estimateLabel = document.getElementById("estimateLabel");
const fancyBar = document.getElementById("fancyBarInner");
const fancyPercent = document.getElementById("fancyPercent");
const summaryBox = document.getElementById("summaryBox");

let selectedFile = null;
let selectedFileName = "";
let completedOutputPath = null;

// ─── UI STATE HELPERS ─────────────────────────────────────────────────────────

function resetUI() {
  // back to “select a file” state
  fileBtn.classList.remove("hidden");
  encodeBtn.classList.remove("visible");
  cancelBtn.classList.remove("visible");
  showFolderBtn.classList.remove("visible");
  progressContainer.classList.remove("visible");
  estimateLabel.classList.add("hidden");
  hideSpinner();
  hideStatusMessage();
}

function prepareEncodingUI() {
  // when user clicks “encode”
  estimateLabel.classList.add("hidden");
  fileBtn.classList.add("hidden");
  encodeBtn.classList.remove("visible");
  cancelBtn.classList.add("visible");
  progressContainer.classList.add("visible");
  hideStatusMessage();
  hideSpinner();
}

function completeUI() {
  // on success
  fileBtn.classList.remove("hidden");
  cancelBtn.classList.remove("visible");
  progressContainer.classList.remove("visible");
  showFolderBtn.classList.add("visible");
  hideSpinner();
}

function cancelUI() {
  // on cancel
  fileBtn.classList.remove("hidden");
  cancelBtn.classList.remove("visible");
  progressContainer.classList.remove("visible");
  hideSpinner();
}

function errorUI() {
  // on error
  cancelBtn.classList.remove("visible");
  progressContainer.classList.remove("visible");
  encodeBtn.classList.remove("visible");
  showFolderBtn.classList.remove("visible");
  fileBtn.classList.remove("hidden"); // bring back the file selector
  estimateLabel.classList.add("hidden");
  hideSpinner();
}

// ─── STATUS & SPINNER HELPERS ────────────────────────────────────────────────

function showStatusMessage(message, type = "info") {
  // clear any previous fade timers
  clearTimeout(statusBox._fadeTimer);

  statusBox.textContent = message;
  statusBox.className = `visible ${type}`;
}

function hideStatusMessage() {
  statusBox.className = "hidden";
  statusBox.textContent = "";
}

function showCancelledMessage() {
  // 1) show it instantly as a warning
  showStatusMessage("Encoding cancelled.", "warning");

  // 2) after 4s, add .fade-out to trigger our CSS transition
  statusBox._fadeTimer = setTimeout(() => {
    statusBox.classList.add("fade-out");

    // 3) after fade completes (0.5s), fully hide + clean up
    setTimeout(() => {
      hideStatusMessage();
      statusBox.classList.remove("fade-out");
    }, 500);
  }, 1000);
}

function showSpinner(message = "Please wait...") {
  spinnerText.textContent = message;
  spinner.classList.remove("hidden");
}

function hideSpinner() {
  spinner.classList.add("hidden");
}

// ─── BUTTON EVENT LISTENERS ───────────────────────────────────────────────────

fileBtn.addEventListener("click", async () => {
  hideStatusMessage();
  hideSpinner();

  const filePath = await openFileDialog();
  if (!filePath) return;

  selectedFile = filePath;
  selectedFileName = filePath.split(/[/\\]/).pop();

  showFolderBtn.classList.remove("visible");
  showSpinner("Analyzing video…");

  try {
    const analysis = await window.electronAPI.analyzeFile(filePath);

    if (analysis.error) {
      encodeBtn.classList.remove("visible");
      showStatusMessage(`Error: ${analysis.error}`, "error");
      estimateLabel.classList.add("hidden");
      return;
    }

    const { estimatedSizeMB } = analysis;
    estimateLabel.textContent = `Estimated output size: ~${estimatedSizeMB} MB`;
    estimateLabel.classList.remove("hidden");
    encodeBtn.classList.add("visible");
    if (analysis.warning) {
      showStatusMessage(analysis.warning, "warning");
    } else {
      showStatusMessage(`Selected file: ${filePath}`, "success");
    }
    console.log("[Renderer] Analysis result:", analysis);
  } catch (err) {
    encodeBtn.classList.remove("visible");
    estimateLabel.classList.add("hidden");
    showStatusMessage(`Failed to analyze video: ${err}`, "error");
  } finally {
    hideSpinner();
  }
});

encodeBtn.addEventListener("click", () => {
  hideStatusMessage();
  hideSpinner();

  if (!selectedFile) {
    showStatusMessage("Please select a video file first.", "error");
    return;
  }

  prepareEncodingUI();
  fancyBar.style.width = `0%`;
  progressHeader.textContent = `Encoding ${selectedFileName}…`;
  startEncoding(selectedFile);
});

cancelBtn.addEventListener("click", () => {
  cancelEncoding();
});

showFolderBtn.addEventListener("click", () => {
  if (completedOutputPath) {
    window.electronAPI.showInFolder(completedOutputPath);
  }
});

// ─── IPC EVENT BINDINGS ───────────────────────────────────────────────────────

onEncodingProgress(({ percent, pass }) => {
  fancyBar.style.width = `${percent}%`;
  fancyPercent.textContent = `${percent}%`;
  passNumberText.textContent = `Pass ${pass} out of 2`;
  hideSpinner();
});

onEncodingCancelled(() => {
  hideStatusMessage();
  hideSpinner();
  cancelUI();
  showCancelledMessage();
});

onEncodingError((err) => {
  hideStatusMessage();
  hideSpinner();
  errorUI();
  showStatusMessage(`Error: ${err}`, "error");
});

onEncodingComplete(({ outputFile }) => {
  hideStatusMessage();
  hideSpinner();
  completedOutputPath = outputFile;
  completeUI();
  showStatusMessage(`Encoding complete! New file in ${outputFile}`, "success");
});

// ─── INITIALIZE ──────────────────────────────────────────────────────────────
resetUI();
