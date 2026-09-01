const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

const id = () => crypto.randomUUID();
const code = () => String(Math.floor(100000 + Math.random() * 900000));

async function body(request) {
  try { return await request.json(); } catch { return {}; }
}

async function dbRequired(env) {
  if (!env.DB) throw new Error("D1 database is not connected. Add a D1 binding named DB and apply schema.sql.");
  return env.DB;
}

async function findLesson(db, roomCode) {
  return db.prepare("SELECT * FROM lessons WHERE code = ?1").bind(roomCode).first();
}

async function teacherLesson(db, roomCode, token) {
  return db.prepare("SELECT * FROM lessons WHERE code = ?1 AND teacher_token = ?2").bind(roomCode, token).first();
}

async function state(db, lesson, teacher = false) {
  const students = await db.prepare(
    "SELECT id, name, joined_at FROM students WHERE lesson_id = ?1 ORDER BY joined_at"
  ).bind(lesson.id).all();

  const questions = await db.prepare(
    "SELECT id, type, text, options_json, sort_order FROM questions WHERE lesson_id = ?1 ORDER BY sort_order, created_at"
  ).bind(lesson.id).all();

  const current = questions.results.find(q => q.id === lesson.current_question_id) || null;
  const result = { lesson: {
    id: lesson.id, code: lesson.code, name: lesson.name, subject: lesson.subject,
    status: lesson.status, currentQuestionId: lesson.current_question_id
  }, students: students.results, questions: questions.results.map(q => ({
    ...q, options: JSON.parse(q.options_json || "[]")
  })), currentQuestion: current ? {
    id: current.id, type: current.type, text: current.text,
    options: JSON.parse(current.options_json || "[]")
  } : null };

  if (teacher && current) {
    const answers = await db.prepare(
      `SELECT a.id, a.student_id, s.name, a.answer_text, a.created_at
       FROM answers a JOIN students s ON s.id = a.student_id
       WHERE a.question_id = ?1 ORDER BY a.created_at`
    ).bind(current.id).all();
    result.answers = answers.results;
  }
  return result;
}

async function api(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();
  const db = await dbRequired(env);

  if (path === "/api/health" && method === "GET") {
    await db.prepare("SELECT 1").first();
    return json({ ok: true, database: true, version: "mvp-1" });
  }

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
    await db.prepare(
      "INSERT INTO lessons (id, code, name, subject, teacher_token) VALUES (?1, ?2, ?3, ?4, ?5)"
    ).bind(lesson.id, lesson.code, lesson.name, lesson.subject, lesson.teacher_token).run();
    return json({ lesson: { code: lesson.code, name: lesson.name, subject: lesson.subject }, teacherToken: lesson.teacher_token });
  }

  const lessonMatch = path.match(/^\/api\/lessons\/([0-9]{6})$/);
  if (lessonMatch && method === "GET") {
    const lesson = await findLesson(db, lessonMatch[1]);
    if (!lesson) return json({ error: "Урок не знайдено." }, 404);
    return json(await state(db, lesson, false));
  }

  const joinMatch = path.match(/^\/api\/lessons\/([0-9]{6})\/join$/);
  if (joinMatch && method === "POST") {
    const lesson = await findLesson(db, joinMatch[1]);
    if (!lesson) return json({ error: "Урок не знайдено." }, 404);
    const data = await body(request);
    const name = String(data.name || "").trim();
    if (!name) return json({ error: "Вкажи своє ім'я." }, 400);
    const student = { id: id(), name };
    await db.prepare("INSERT INTO students (id, lesson_id, name) VALUES (?1, ?2, ?3)")
      .bind(student.id, lesson.id, student.name).run();
    return json({ studentId: student.id, lesson: { code: lesson.code, name: lesson.name, subject: lesson.subject } });
  }

  const studentState = path.match(/^\/api\/lessons\/([0-9]{6})\/student\/([^/]+)$/);
  if (studentState && method === "GET") {
    const lesson = await findLesson(db, studentState[1]);
    if (!lesson) return json({ error: "Урок не знайдено." }, 404);
    const student = await db.prepare("SELECT id, name FROM students WHERE id = ?1 AND lesson_id = ?2")
      .bind(studentState[2], lesson.id).first();
    if (!student) return json({ error: "Учня не знайдено." }, 403);
    return json(await state(db, lesson, false));
  }

  const answerMatch = path.match(/^\/api\/lessons\/([0-9]{6})\/answer$/);
  if (answerMatch && method === "POST") {
    const lesson = await findLesson(db, answerMatch[1]);
    if (!lesson || !lesson.current_question_id) return json({ error: "Зараз немає активного питання." }, 400);
    const data = await body(request);
    const studentId = String(data.studentId || "");
    const answerText = String(data.answer || "").trim();
    const student = await db.prepare("SELECT id FROM students WHERE id = ?1 AND lesson_id = ?2").bind(studentId, lesson.id).first();
    if (!student) return json({ error: "Учня не знайдено." }, 403);
    if (!answerText) return json({ error: "Обери або введи відповідь." }, 400);
    await db.prepare(
      `INSERT INTO answers (id, question_id, student_id, answer_text) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(question_id, student_id) DO UPDATE SET answer_text = excluded.answer_text, created_at = CURRENT_TIMESTAMP`
    ).bind(id(), lesson.current_question_id, studentId, answerText).run();
    return json({ ok: true });
  }

  const teacherState = path.match(/^\/api\/teacher\/lessons\/([0-9]{6})$/);
  if (teacherState && method === "GET") {
    const token = url.searchParams.get("token") || "";
    const lesson = await teacherLesson(db, teacherState[1], token);
    if (!lesson) return json({ error: "Немає доступу." }, 403);
    return json(await state(db, lesson, true));
  }

  const questionMatch = path.match(/^\/api\/teacher\/lessons\/([0-9]{6})\/questions$/);
  if (questionMatch && method === "POST") {
    const data = await body(request);
    const lesson = await teacherLesson(db, questionMatch[1], String(data.token || ""));
    if (!lesson) return json({ error: "Немає доступу." }, 403);
    const text = String(data.text || "").trim();
    if (!text) return json({ error: "Вкажи текст питання." }, 400);
    const options = Array.isArray(data.options) ? data.options.map(String).filter(Boolean) : [];
    const count = await db.prepare("SELECT COUNT(*) AS n FROM questions WHERE lesson_id = ?1").bind(lesson.id).first();
    const question = { id: id(), type: options.length ? "choice" : "text", text };
    await db.prepare(
      "INSERT INTO questions (id, lesson_id, type, text, options_json, sort_order) VALUES (?1, ?2, ?3, ?4, ?5, ?6)"
    ).bind(question.id, lesson.id, question.type, question.text, JSON.stringify(options), count.n || 0).run();
    return json({ question });
  }

  const controlMatch = path.match(/^\/api\/teacher\/lessons\/([0-9]{6})\/control$/);
  if (controlMatch && method === "POST") {
    const data = await body(request);
    const lesson = await teacherLesson(db, controlMatch[1], String(data.token || ""));
    if (!lesson) return json({ error: "Немає доступу." }, 403);
    const action = String(data.action || "");
    if (action === "start") {
      await db.prepare("UPDATE lessons SET status = 'live' WHERE id = ?1").bind(lesson.id).run();
    } else if (action === "next") {
      const questions = await db.prepare("SELECT id FROM questions WHERE lesson_id = ?1 ORDER BY sort_order, created_at").bind(lesson.id).all();
      const index = questions.results.findIndex(q => q.id === lesson.current_question_id);
      const next = questions.results[index + 1] || questions.results[0];
      if (!next) return json({ error: "Спочатку додай питання." }, 400);
      await db.prepare("UPDATE lessons SET status = 'live', current_question_id = ?1 WHERE id = ?2").bind(next.id, lesson.id).run();
    } else if (action === "stop") {
      await db.prepare("UPDATE lessons SET status = 'finished' WHERE id = ?1").bind(lesson.id).run();
    } else {
      return json({ error: "Невідома команда." }, 400);
    }
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
      catch (error) {
        console.error(error);
        return json({ error: error.message || "Помилка сервера." }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  }
};
