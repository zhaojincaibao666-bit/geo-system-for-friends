const response = await fetch("http://127.0.0.1:4318/api/doubao-browser/login", { method: "POST" });
if (!response.ok) throw new Error(`Unable to reach the local GEO service: ${response.status}`);
const result = await response.json();
console.log(`Doubao browser login state: ${result.state}`);
console.log("The request reuses the GEO service's only persistent Chromium. Complete any login in that dedicated window; do not start a second login browser.");
