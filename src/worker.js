const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

const id = () => crypto.randomUUID();
const code = () => String(Math.floor(100000 + Math.random() * 900000));
let schemaReady = false;

async function body(request) {
  try { return await request.json(); } catch { return {}; }
}

async function dbRequired(env) {
  if (!env.DB) throw new Error("D1 database is not connected. Add a D1 binding named DB.");
  if (!schemaReady) {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS lessons (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        subject TEXT NOT NULL,
        teacher_token TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'waiting',
        current_question_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS students (
        id TEXT PRIMARY KEY,
        lesson_id TEXT NOT NULL,
        name TEXT NOT NULL,
        joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE CASCADE
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        lesson_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'choice',
        text TEXT NOT NULL,
        options_json TEXT NOT NULL DEFAULT '[]',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE CASCADE
      )`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS answers (
        id TEXT PRIMARY KEY,
        question_id TEXT NOT NULL,
        student_id TEXT NOT NULL,
        answer_text TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(question_id, student_id),
        FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
      )`),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_lessons_code ON lessons(code)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_students_lesson ON students(lesson_id)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_questions_lesson ON questions(lesson_id)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_answers_question ON answers(question_id)")
    ]);
    schemaReady = true;
  }
  return env.DB;
}

async function findLesson(db, roomCode) {
  return db.prepare("SELECT * FROM lessons WHERE code = ?1").bind(roomCode).first();
}

async function teacherLesson(db, roomCode, token) {
  return db.prepare("SELECT * FROM lessons WHERE code = ?1 AND teacher_token = ?2").bind(roomCode, token).first();
}

async function state(db, lesson, teacher = false) {
  const students = await db.prepare("SELECT id, name, joined_at FROM students WHERE lesson_id = ?1 ORDER BY joined_at").bind(lesson.id).all();
  const questions = await db.prepare("SELECT id, type, text, options_json, sort_order FROM questions WHERE lesson_id = ?1 ORDER BY sort_order, created_at").bind(lesson.id).all();
  const current = questions.results.find(q => q.id === lesson.current_question_id) || null;
  const result = {
    lesson: { id: lesson.id, code: lesson.code, name: lesson.name, subject: lesson.subject, status: lesson.status, currentQuestionId: lesson.current_question_id },
    students: students.results,
    questions: questions.results.map(q => ({ ...q, options: JSON.parse(q.options_json || "[]") })),
    currentQuestion: current ? { id: current.id, type: current.type, text: current.text, options: JSON.parse(current.options_json || "[]") } : null
  };
  if (teacher && current) {
    const answers = await db.prepare(`
      SELECT a.id, a.student_id, s.name, a.answer_text, a.created_at
      FROM answers a JOIN students s ON s.id = a.student_id
      WHERE a.question_id = ?1 ORDER BY a.created_at
    `).bind(current.id).all();
    result.answers = answers.results;
  }
  return result;
}

function normalizeQuestions(raw) {
  if (!Array.isArray(raw)) throw new Error("questions має бути масивом.");
  if (!raw.length) throw new Error("Урок не містить питань.");
  if (raw.length > 50) throw new Error("За один імпорт можна додати максимум 50 питань.");
  return raw.map((q, index) => {
    const text = String(q?.text || "").trim();
    if (!text) throw new Error(`Питання №${index + 1} не має тексту.`);
    const options = Array.isArray(q?.options) ? q.options.map(String).map(v => v.trim()).filter(Boolean).slice(0, 6) : [];
    const type = options.length ? "choice" : "text";
    return { text, options, type };
  });
}

async function api(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const db = await dbRequired(env);

  if (path === "/api/health" && method === "GET") return json({ ok: true, database: true, version: "mvp-3" });

  if (path === "/api/lessons" && method === "POST") {
    const data = await body(request);
    const name = String(data.name || "").trim();
    const subject = String(data.subject || "").trim();
    if (!name) return json({ error: "Вкажи назву уроку." }, 400);
    let roomCode = code();
    for (let i = 0; i < 5; i++) {
      if (!(await findLesson(db, roomCode))) break;
      roomCode = code();
    }
    const lesson = { id: id(), code: roomCode, name, subject: subject || "Шкільний урок", teacher_token: id() };
    await db.prepare("INSERT INTO lessons (id, code, name, subject, teacher_token) VALUES (?1, ?2, ?3, ?4, ?5)").bind(lesson.id, lesson.code, lesson.name, lesson.subject, lesson.teacher_token).run();
    return json({ lesson: { code: lesson.code, name: lesson.name, subject: lesson.subject }, teacherToken: lesson.teacher_token });
  }

  let m = path.match(/^\/api\/lessons\/([0-9]{6})$/);
  if (m && method === "GET") {
    const lesson = await findLesson(db, m[1]);
    if (!lesson) return json({ error: "Урок не знайдено." }, 404);
    return json(await state(db, lesson));
  }

  m = path.match(/^\/api\/lessons\/([0-9]{6})\/join$/);
  if (m && method === "POST") {
    const lesson = await findLesson(db, m[1]);
    if (!lesson) return json({ error: "Урок не знайдено." }, 404);
    const name = String((await body(request)).name || "").trim();
    if (!name) return json({ error: "Вкажи своє ім'я." }, 400);
    const student = { id: id(), name };
    await db.prepare("INSERT INTO students (id, lesson_id, name) VALUES (?1, ?2, ?3)").bind(student.id, lesson.id, student.name).run();
    return json({ studentId: student.id, lesson: { code: lesson.code, name: lesson.name, subject: lesson.subject } });
  }

  m = path.match(/^\/api\/lessons\/([0-9]{6})\/student\/([^/]+)$/);
  if (m && method === "GET") {
    const lesson = await findLesson(db, m[1]);
    if (!lesson) return json({ error: "Урок не знайдено." }, 404);
    const student = await db.prepare("SELECT id FROM students WHERE id = ?1 AND lesson_id = ?2").bind(m[2], lesson.id).first();
    if (!student) return json({ error: "Учня не знайдено." }, 403);
    return json(await state(db, lesson));
  }

  m = path.match(/^\/api\/lessons\/([0-9]{6})\/answer$/);
  if (m && method === "POST") {
    const lesson = await findLesson(db, m[1]);
    if (!lesson || !lesson.current_question_id) return json({ error: "Зараз немає активного питання." }, 400);
    const data = await body(request);
    const studentId = String(data.studentId || "");
    const answerText = String(data.answer || "").trim();
    const student = await db.prepare("SELECT id FROM students WHERE id = ?1 AND lesson_id = ?2").bind(studentId, lesson.id).first();
    if (!student) return json({ error: "Учня не знайдено." }, 403);
    if (!answerText) return json({ error: "Обери або введи відповідь." }, 400);
    await db.prepare(`INSERT INTO answers (id, question_id, student_id, answer_text) VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(question_id, student_id) DO UPDATE SET answer_text = excluded.answer_text, created_at = CURRENT_TIMESTAMP`).bind(id(), lesson.current_question_id, studentId, answerText).run();
    return json({ ok: true });
  }

  m = path.match(/^\/api\/teacher\/lessons\/([0-9]{6})$/);
  if (m && method === "GET") {
    const lesson = await teacherLesson(db, m[1], url.searchParams.get("token") || "");
    if (!lesson) return json({ error: "Немає доступу." }, 403);
    return json(await state(db, lesson, true));
  }

  m = path.match(/^\/api\/teacher\/lessons\/([0-9]{6})\/questions$/);
  if (m && method === "POST") {
    const data = await body(request);
    const lesson = await teacherLesson(db, m[1], String(data.token || ""));
    if (!lesson) return json({ error: "Немає доступу." }, 403);
    const text = String(data.text || "").trim();
    if (!text) return json({ error: "Вкажи текст питання." }, 400);
    const options = Array.isArray(data.options) ? data.options.map(String).map(v => v.trim()).filter(Boolean).slice(0, 6) : [];
    const count = await db.prepare("SELECT COUNT(*) AS n FROM questions WHERE lesson_id = ?1").bind(lesson.id).first();
    const question = { id: id(), type: options.length ? "choice" : "text", text };
    await db.prepare(`INSERT INTO questions (id, lesson_id, type, text, options_json, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`).bind(question.id, lesson.id, question.type, question.text, JSON.stringify(options), count.n || 0).run();
    return json({ question });
  }

  m = path.match(/^\/api\/teacher\/lessons\/([0-9]{6})\/questions\/import$/);
  if (m && method === "POST") {
    const data = await body(request);
    const lesson = await teacherLesson(db, m[1], String(data.token || ""));
    if (!lesson) return json({ error: "Немає доступу." }, 403);
    const questions = normalizeQuestions(data.questions);
    const count = await db.prepare("SELECT COUNT(*) AS n FROM questions WHERE lesson_id = ?1").bind(lesson.id).first();
    const startOrder = Number(count?.n || 0);
    const statements = questions.map((q, index) => db.prepare(
      `INSERT INTO questions (id, lesson_id, type, text, options_json, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    ).bind(id(), lesson.id, q.type, q.text, JSON.stringify(q.options), startOrder + index));
    await db.batch(statements);
    return json({ ok: true, imported: questions.length, lesson: { code: lesson.code, name: lesson.name, subject: lesson.subject } });
  }

  m = path.match(/^\/api\/teacher\/lessons\/([0-9]{6})\/control$/);
  if (m && method === "POST") {
    const data = await body(request);
    const lesson = await teacherLesson(db, m[1], String(data.token || ""));
    if (!lesson) return json({ error: "Немає доступу." }, 403);
    const action = String(data.action || "");
    if (action === "start") {
      const first = await db.prepare("SELECT id FROM questions WHERE lesson_id = ?1 ORDER BY sort_order, created_at LIMIT 1").bind(lesson.id).first();
      if (!first) return json({ error: "Спочатку додай або імпортуй питання." }, 400);
      await db.prepare("UPDATE lessons SET status = 'live', current_question_id = ?1 WHERE id = ?2").bind(first.id, lesson.id).run();
    } else if (action === "next") {
      const questions = await db.prepare("SELECT id FROM questions WHERE lesson_id = ?1 ORDER BY sort_order, created_at").bind(lesson.id).all();
      const index = questions.results.findIndex(q => q.id === lesson.current_question_id);
      const next = questions.results[index + 1] || questions.results[0];
      if (!next) return json({ error: "Спочатку додай питання." }, 400);
      await db.prepare("UPDATE lessons SET status = 'live', current_question_id = ?1 WHERE id = ?2").bind(next.id, lesson.id).run();
    } else if (action === "stop") {
      await db.prepare("UPDATE lessons SET status = 'finished' WHERE id = ?1").bind(lesson.id).run();
    } else return json({ error: "Невідома команда." }, 400);
    const updated = await db.prepare("SELECT * FROM lessons WHERE id = ?1").bind(lesson.id).first();
    return json(await state(db, updated, true));
  }

  return json({ error: "API route not found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await api(request, env); }
      catch (error) { console.error(error); return json({ error: error.message || "Помилка сервера." }, 500); }
    }
    return env.ASSETS.fetch(request);
  }
};
