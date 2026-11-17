const [origin, action, sql] = process.argv.slice(2);
if (!origin || !["query", "run"].includes(action) || !sql) {
  throw new Error("Invalid local D1 integration command");
}

const response = await fetch(`${origin}/api/__integration/database`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action, sql }),
});
const text = await response.text();
let result;
try {
  result = JSON.parse(text);
} catch (error) {
  if (!response.ok) {
    throw new Error(
      `Local D1 ${action} failed with status ${response.status}: ${text}`,
      { cause: error },
    );
  }
  throw error;
}
if (!response.ok) {
  throw new Error(`Local D1 ${action} failed with status ${response.status}: ${JSON.stringify(result)}`);
}
process.stdout.write(JSON.stringify([result]));
