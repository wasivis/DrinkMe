const fs = require("fs");
const path = require("path");

module.exports = async function (context) {
  const localeDir = path.join(context.appOutDir, "locales");

  try {
    const files = fs.readdirSync(localeDir);
    for (const file of files) {
      if (!file.includes("en-US")) {
        fs.unlinkSync(path.join(localeDir, file));
      }
    }
    console.log("✅ Removed unused locale files");
  } catch (err) {
    console.warn("⚠️ Could not clean locales:", err.message);
  }
};
