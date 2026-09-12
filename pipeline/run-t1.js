import { openCaptureSession, saveProfile } from './session.js';

async function main() {
  console.log("🚀 Starting Steel Cloud Browser...");
  // 1. Open the session where you can log in manually
  const handle = await openCaptureSession();
  
  // 2. Once you press Enter in the terminal, it saves your cookies!
  await saveProfile(handle);
  
  console.log("✅ Task T1 Complete! Profile saved.");
}

main();