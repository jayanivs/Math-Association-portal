require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const port = process.env.PORT || 3000;

// PostgreSQL connection pool using env variables
const pool = new Pool({
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: process.env.PGPORT,
});

app.use(cors());
app.use(bodyParser.json());

// Serve static frontend files from project root
const path = require('path');
app.use(express.static(path.join(__dirname, '/')));

// Redirect root URL "/" to login.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

// Helper function to validate email domain
function isValidDomain(email) {
  const domain = email.split('@')[1];
  return domain === 'psgtech.ac.in';
}

// Signup endpoint
app.post('/signup', async (req, res) => {
  const { email, password, userType } = req.body;

  if (!email || !password || !userType) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!isValidDomain(email)) {
    return res.status(400).json({ error: 'Invalid email domain' });
  }

  try {
    // Check if user already exists
    const userCheck = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userCheck.rows.length > 0) {
      return res.status(400).json({ error: 'User already exists' });
    }

    // Insert new user
    await pool.query(
      'INSERT INTO users (email, password, user_type) VALUES ($1, $2, $3)',
      [email, password, userType]
    );

    res.json({ message: 'Signup successful' });
  } catch (err) {
    console.error('Error during signup:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Login endpoint
app.post('/login', async (req, res) => {
  const { email, password, userType } = req.body;

  if (!email || !password || !userType) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  if (!isValidDomain(email)) {
    return res.status(400).json({ error: 'Invalid email domain' });
  }

  try {
    // Check if user exists and password matches
    const userCheck = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND password = $2 AND user_type = $3',
      [email, password, userType]
    );

    if (userCheck.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    res.json({ message: 'Login successful' });
  } catch (err) {
    console.error('Error during login:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all events
app.get('/events', async (req, res) => {
  try {
    const result = await pool.query('SELECT title, date, description, registration_link FROM events ORDER BY date');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching events:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/teachers', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.id, 
        u.email, 
        ti.qualification, 
        ti.class_handling AS "classHandling", 
        ti.achievements,
        ti.picture
      FROM users u
      LEFT JOIN teacher_info ti ON u.id = ti.user_id
      WHERE u.user_type = 'teacher'
    `);
    console.log('Teachers fetched:', result.rows);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching teachers:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// Student sends teacher connect request
app.post('/teacher-connect-request', async (req, res) => {
  const { studentEmail, teacherId } = req.body;
  if (!studentEmail || !teacherId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    // Get student id
    const studentRes = await pool.query('SELECT id FROM users WHERE email = $1 AND user_type = $2', [studentEmail, 'student']);
    if (studentRes.rows.length === 0) {
      return res.status(400).json({ error: 'Student not found' });
    }
    const studentId = studentRes.rows[0].id;

    // Check if request already exists
    const existingReq = await pool.query(
      'SELECT * FROM teacher_connect_requests WHERE student_id = $1 AND teacher_id = $2',
      [studentId, teacherId]
    );
    if (existingReq.rows.length > 0) {
      return res.status(400).json({ error: 'Request already sent' });
    }

    // Insert request
    await pool.query(
      'INSERT INTO teacher_connect_requests (student_id, teacher_id, status) VALUES ($1, $2, $3)',
      [studentId, teacherId, 'pending']
    );

    res.json({ message: 'Request sent' });
  } catch (err) {
    console.error('Error sending connect request:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Teacher gets connection requests
app.get('/teacher-connect-requests', async (req, res) => {
  const teacherEmail = req.query.teacherEmail;
  if (!teacherEmail) {
    return res.status(400).json({ error: 'Missing teacher email' });
  }
  try {
    // Get teacher id
    const teacherRes = await pool.query('SELECT id FROM users WHERE email = $1 AND user_type = $2', [teacherEmail, 'teacher']);
    if (teacherRes.rows.length === 0) {
      return res.status(400).json({ error: 'Teacher not found' });
    }
    const teacherId = teacherRes.rows[0].id;

    // Get pending requests
    const requests = await pool.query(
      `SELECT r.id, u.email as student_email
       FROM teacher_connect_requests r
       JOIN users u ON r.student_id = u.id
       WHERE r.teacher_id = $1 AND r.status = 'pending'`,
      [teacherId]
    );

    res.json(requests.rows);
  } catch (err) {
    console.error('Error fetching connect requests:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Teacher accepts connection request
app.post('/accept-teacher-connect-request', async (req, res) => {
  const { requestId } = req.body;
  if (!requestId) {
    return res.status(400).json({ error: 'Missing request ID' });
  }
  try {
    // Get the connection request details to notify student
    const requestRes = await pool.query(
      'SELECT student_id, teacher_id FROM teacher_connect_requests WHERE id = $1',
      [requestId]
    );
    if (requestRes.rows.length === 0) {
      return res.status(400).json({ error: 'Request not found' });
    }
    const { student_id, teacher_id } = requestRes.rows[0];

    // Get student email
    const studentRes = await pool.query('SELECT email FROM users WHERE id = $1', [student_id]);
    if (studentRes.rows.length === 0) {
      return res.status(400).json({ error: 'Student not found' });
    }
    const studentEmail = studentRes.rows[0].email;

    // Get teacher email
    const teacherRes = await pool.query('SELECT email FROM users WHERE id = $1', [teacher_id]);
    if (teacherRes.rows.length === 0) {
      return res.status(400).json({ error: 'Teacher not found' });
    }
    const teacherEmail = teacherRes.rows[0].email;

    // Update request status to accepted
    await pool.query(
      'UPDATE teacher_connect_requests SET status = $1 WHERE id = $2',
      ['accepted', requestId]
    );

    // Emit socket.io event to notify student
    // Log connected users for debugging
    console.log('Connected users:', Array.from(connectedUsers.keys()));
    if (connectedUsers.has(studentEmail)) {
      console.log(`Emitting connectionAccepted to student ${studentEmail}`);
    } else {
      console.log(`Student ${studentEmail} not connected`);
    }
    // Emit to the room named after the student's email for reliability
    io.to(studentEmail).emit('connectionAccepted', {
      teacherEmail,
      studentEmail,
    });

    res.json({ message: 'Request accepted' });
  } catch (err) {
    console.error('Error accepting connect request:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all books
app.get('/books', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM books ORDER BY title');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching books:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Request a book (reduce available_copies by 1) and log the action
app.post('/request-book', async (req, res) => {
  const { bookId, userEmail } = req.body;
  if (!bookId || !userEmail) {
    return res.status(400).json({ error: 'Missing book ID or user email' });
  }
  try {
    // Check current available_copies
    const bookRes = await pool.query('SELECT available_copies FROM books WHERE id = $1', [bookId]);
    if (bookRes.rows.length === 0) {
      return res.status(404).json({ error: 'Book not found' });
    }
    const currentAvailableCopies = bookRes.rows[0].available_copies;
    if (currentAvailableCopies <= 0) {
      return res.status(400).json({ error: 'Book not available' });
    }
    // Reduce available_copies by 1
    await pool.query('UPDATE books SET available_copies = available_copies - 1 WHERE id = $1', [bookId]);
    // Insert log entry
    await pool.query(
      'INSERT INTO book_logs (book_id, action, user_email) VALUES ($1, $2, $3)',
      [bookId, 'request', userEmail]
    );
    res.json({ message: 'Book requested successfully' });
  } catch (err) {
    console.error('Error requesting book:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Return a book (increase available_copies by 1) and log the action
app.post('/return-book', async (req, res) => {
  const { bookId, userEmail } = req.body;
  if (!bookId || !userEmail) {
    return res.status(400).json({ error: 'Missing book ID or user email' });
  }
  try {
    // Check if book exists
    const bookRes = await pool.query('SELECT available_copies FROM books WHERE id = $1', [bookId]);
    if (bookRes.rows.length === 0) {
      return res.status(404).json({ error: 'Book not found' });
    }
    // Increase available_copies by 1
    await pool.query('UPDATE books SET available_copies = available_copies + 1 WHERE id = $1', [bookId]);
    // Insert log entry
    await pool.query(
      'INSERT INTO book_logs (book_id, action, user_email) VALUES ($1, $2, $3)',
      [bookId, 'return', userEmail]
    );
    res.json({ message: 'Book returned successfully' });
  } catch (err) {
    console.error('Error returning book:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all association members
app.get('/association-members', async (req, res) => {
  try {
    // Check if association_members table exists
    const tableCheck = await pool.query("SELECT to_regclass('public.association_members') AS exists");
    if (!tableCheck.rows[0].exists) {
      return res.status(500).json({ error: 'Association members table does not exist' });
    }
    const result = await pool.query('SELECT * FROM association_members ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching association members:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const server = require('http').createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  }
});

const connectedUsers = new Map();

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('identify', (data) => {
    // data is expected to be { email, role }
    if (typeof data === 'string') {
      // fallback for old clients sending just email string
      connectedUsers.set(data, socket.id);
      socket.join(data);
      console.log(`User identified: ${data} with socket id ${socket.id} and joined room ${data}`);
    } else if (data && data.email && data.role) {
      const key = `${data.email}:${data.role}`;
      connectedUsers.set(key, socket.id);
      socket.join(key);
      console.log(`User identified: ${key} with socket id ${socket.id} and joined room ${key}`);
    } else {
      console.log('Invalid identify data received:', data);
    }
  });

  socket.on('joinRoom', (room) => {
    socket.join(room);
    console.log(`Socket ${socket.id} joined room ${room}`);
  });

  socket.on('chat message', async (msg) => {
    const { room, studentEmail, teacherEmail, sender, message } = msg;
    console.log(`Chat message in room ${room} from ${sender}: ${message}`);

    // Broadcast message to all sockets in the room except sender
    socket.to(room).emit('chat message', msg);

    // Save message to database for persistence
    try {
      await pool.query(
        'INSERT INTO chat_messages (student_email, teacher_email, sender, message, timestamp) VALUES ($1, $2, $3, $4, NOW())',
        [studentEmail, teacherEmail, sender, message]
      );
    } catch (err) {
      console.error('Error saving chat message:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    for (const [key, id] of connectedUsers.entries()) {
      if (id === socket.id) {
        connectedUsers.delete(key);
        break;
      }
    }
  });
});

// Endpoint to get chat messages between student and teacher
app.get('/chat-messages', async (req, res) => {
  const { studentEmail, teacherEmail } = req.query;
  if (!studentEmail || !teacherEmail) {
    return res.status(400).json({ error: 'Missing studentEmail or teacherEmail' });
  }
  try {
    const result = await pool.query(
      `SELECT sender, message, timestamp
       FROM chat_messages
       WHERE (student_email = $1 AND teacher_email = $2)
          OR (student_email = $2 AND teacher_email = $1)
       ORDER BY timestamp ASC`,
      [studentEmail, teacherEmail]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching chat messages:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

server.listen(port, () => {
  console.log(`Backend server running on http://localhost:${port}`);
});
