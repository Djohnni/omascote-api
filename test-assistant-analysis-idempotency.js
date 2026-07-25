const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omascote-assistant-auth-"));
process.env.OMASCOTE_DATA_DIR = dataDir;
process.env.JWT_SECRET = "assistant-auth-test-secret";
process.env.OPENAI_API_KEY = "test-key";

const nativeFetch = global.fetch;
const NativeResponse = global.Response;
let openAiCalls = 0;
let responseMode = "one";
const VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

function mockGames() {
  const one = {
    time_a: "Azul FC",
    time_b: "Verde EC",
    data: "25/07/2026",
    horario: "15:00",
    competicao: "Copa Teste"
  };
  if (responseMode === "one") return [one];
  return [
    one,
    {
      time_a: "Amarelo FC",
      time_b: "Vermelho EC",
      data: "26/07/2026",
      horario: "17:00",
      competicao: "Liga Teste"
    }
  ];
}

global.fetch = async (url) => {
  assert.equal(url, "https://api.openai.com/v1/responses");
  openAiCalls += 1;
  await new Promise((resolve) => setTimeout(resolve, 80));
  return new NativeResponse(JSON.stringify({
    status: "completed",
    output_text: JSON.stringify({ jogos: mockGames() })
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
};

const { app } = require("./server");

function createImageForm(bytes) {
  const form = new FormData();
  form.append(
    "imagem",
    new Blob([Buffer.from(bytes)], { type: "image/png" }),
    "fixture.png"
  );
  return form;
}

async function postImage(baseUrl, token, requestId, bytes) {
  return nativeFetch(`${baseUrl}/me/time/jogos/identificar-por-foto`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Idempotency-Key": requestId
    },
    body: createImageForm(bytes)
  });
}

async function main() {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const register = await nativeFetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        whatsapp: "assistente_teste",
        senha: "senha123",
        nome_time: "Assistente Teste"
      })
    });
    assert.equal(register.status, 200);
    const account = await register.json();
    assert.equal(account.ok, true);

    const imageOne = VALID_PNG;
    const firstId = "foto-jogos-concurrent-request";
    const [firstResponse, concurrentReplay] = await Promise.all([
      postImage(baseUrl, account.token, firstId, imageOne),
      postImage(baseUrl, account.token, firstId, imageOne)
    ]);
    assert.equal(firstResponse.status, 200);
    assert.equal(concurrentReplay.status, 200);
    const first = await firstResponse.json();
    const replay = await concurrentReplay.json();
    assert.equal(first.jogos.length, 1);
    assert.deepEqual(replay.jogos, first.jogos);
    assert.equal(openAiCalls, 1, "concorrencia deve chamar a IA somente uma vez");
    assert.equal(
      [first.idempotent_replay, replay.idempotent_replay].filter(Boolean).length,
      1
    );

    const completedReplayResponse = await postImage(
      baseUrl,
      account.token,
      firstId,
      imageOne
    );
    assert.equal(completedReplayResponse.status, 200);
    const completedReplay = await completedReplayResponse.json();
    assert.equal(completedReplay.idempotent_replay, true);
    assert.equal(openAiCalls, 1, "retomada concluida nao deve chamar a IA novamente");

    const conflict = await postImage(
      baseUrl,
      account.token,
      firstId,
      Buffer.concat([VALID_PNG, Buffer.from([9])])
    );
    assert.equal(conflict.status, 409);
    assert.equal(openAiCalls, 1);

    responseMode = "multi";
    const second = await postImage(
      baseUrl,
      account.token,
      "foto-jogos-new-request",
      Buffer.concat([VALID_PNG, Buffer.from([5])])
    );
    assert.equal(second.status, 200);
    const secondPayload = await second.json();
    assert.equal(secondPayload.jogos.length, 2);
    assert.equal(openAiCalls, 2, "nova imagem deve gerar uma nova analise");

    process.stdout.write(
      JSON.stringify({
        ok: true,
        concurrent_dedupe: true,
        completed_replay: true,
        image_conflict: true,
        one_game: true,
        multiple_games: true,
        openai_calls: openAiCalls
      }, null, 2) + "\n"
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    global.fetch = nativeFetch;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  global.fetch = nativeFetch;
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
