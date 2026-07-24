const clean = (value: unknown, maximum = 240) =>
  typeof value === "string"
    ? value.replace(/[\r\n\t]+/g, " ").trim().slice(0, maximum)
    : "";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid event" }, { status: 400 });
  }
  if (
    body.event !== "configuration-import" ||
    !["started", "succeeded", "failed"].includes(String(body.status))
  ) {
    return Response.json({ error: "Unsupported event" }, { status: 400 });
  }

  const fileName = clean(body.fileName, 160) || "unnamed file";
  const fileSize =
    typeof body.fileSize === "number" &&
    Number.isSafeInteger(body.fileSize) &&
    body.fileSize >= 0
      ? body.fileSize
      : undefined;
  const status = String(body.status);
  const countNames = [
    "rooms",
    "channels",
    "switches",
    "scenes",
    "periods",
    "users",
  ];
  const counts = countNames.flatMap((name) =>
    typeof body[name] === "number" &&
    Number.isSafeInteger(body[name]) &&
    body[name] >= 0
      ? [`${name}=${body[name]}`]
      : [],
  );
  const message = clean(body.message);
  const detail = [
    fileSize === undefined ? "" : `${fileSize} bytes`,
    ...counts,
    message,
  ].filter(Boolean).join(", ");
  const output = `Configuration import ${status}: ${fileName}${detail ? ` (${detail})` : ""}`;
  if (status === "failed") console.error(output);
  else console.log(output);
  return new Response(null, { status: 204 });
}
