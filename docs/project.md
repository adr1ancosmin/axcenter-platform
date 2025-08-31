You are helping me evolve a small education platform (frontend + backend). Here’s the current system snapshot and constraints. Use this as context for all future tasks.

- **Deployments**
  - **Frontend (static HTML/CSS/JS)** on Netlify at `https://www.axcenter.ro`.
  - **Backend (Node/Express + SQLite)** on Render at `https://axcenter-platform.onrender.com`.
  - Netlify `_redirects` (at site root) forwards requests to the API:
    - `/api/*  https://axcenter-platform.onrender.com/api/:splat  200`
    - `/uploads/*  https://axcenter-platform.onrender.com/uploads/:splat  200`
  - Frontend uses `const API_BASE = ''` (relative paths). All requests go through Netlify → Render.

- **Tech stack**
  - Backend: Node/Express, `sqlite3`, `multer`, `cors`, `nanoid`.
  - DB: SQLite file in `server/` (production path via `DATA_DIR` env).
  - Frontend: single-page style HTML `platforma.html` with embedded JS and CSS, plus dedicated admin pages:
    - `admin-student.html`, `admin-materials.html`, `admin-homeworks.html`,
      `admin-daily-lesson.html`, `admin-quizzes.html`, `admin-report.html`.
  - Auth: login with username/password; server issues a token stored in `localStorage` and sent via `x-auth-token`. Tokens are in-memory on the server (stateless restart clears sessions).

- **Users, roles, enrollments**
  - Roles: `admin` and `student`. Seed admin exists: `admin / admin123` (if DB empty).
  - Students have a single grade (e.g., `clasa-3`), and multiple subject-group enrollments.
  - Subjects: `romana`, `matematica`, `engleza`.

- **Data model (tables)**
  - `users(id, username, password, role, grade, group_name)`
  - `enrollments(id, user_id, subject, grade, group_name)` — per-subject enrollment
  - `pdfs(id, subject, grade, title, description, file_path, created_at)` — “Materiale”
  - `homeworks(id, subject, grade, group_name, title, description, due_date, pdf_path, created_at)`
  - `quizzes(id, subject, grade, group_name, title)`; `questions(id, quiz_id, text, options_json, correct_index)`;
    `results(id, user_id, quiz_id, score, created_at)`
  - `reports(id, user_id, date, prezenta, lectia, tema, atentie, nota_test, observatii, created_at)`
  - `daily_lessons(id, subject, grade, group_name, title, description, file_path, date, created_at)`
  - `hw_submissions(id, homework_id, user_id, file_path, created_at)`

- **Key filtering rules (student view)**
  - **Materiale (PDFs)**: show if (subject, grade) matches any student enrollment.
  - **Lecția de zi**: show if (subject, grade, group) fully matches an enrollment.
  - **Teme**: show if (subject, grade) matches enrollment and (`group_name` is null or equals the enrollment group).
  - **Teste (quizzes)**: show if (subject, grade) matches enrollment and (`group_name` is null or equals the enrollment group).

- **Admin capabilities (each on its own page)**
  - Create students with multiple subjects (enrollments); search students by username/subject/grade.
  - Add/search/delete materials (subject + grade + title + description + PDF).
  - Add/search/delete homeworks (subject + grade + group + title + description + deadline + PDF).
  - Add/search/delete daily lessons (subject + grade + group + title + description + date + PDF).
  - Create quizzes (subject + grade + optional group), add questions, delete quizzes (or all).
  - Add weekly reports, list/filter reports by student; delete individual reports.
  - View homework submissions (expand “Vezi trimiteri” to see per-student PDF links).

- **Student capabilities**
  - View filtered materials, daily lessons, quizzes, and homeworks.
  - Upload homework PDF per homework; see submission status/link.

- **Frontend structure**
  - `platforma.html` contains UI for Materiale/Teme/Teste/Lecția de zi/Parinți and a hidden Admin tab (visible for admins).
  - Mobile-friendly sidebar; “Vezi trimiteri” appears on homework cards for admin.

- **Conventions/constraints**
  - Keep `API_BASE = ''` (relative) and rely on Netlify `_redirects`.
  - Keep indentation style, don’t change tabs/spaces in files you edit.
  - Preserve the subject keys: `romana`, `matematica`, `engleza`.
  - When adding new API routes, follow the same auth header (`x-auth-token`) and JSON error style.
  - Use `multer` for file uploads to `/uploads`, returning a `file_path` like `/uploads/<filename>.pdf`.