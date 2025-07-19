import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import mongoose from 'mongoose';
import admin from 'firebase-admin';

// --- 0. TIMEZONE UTILITY FOR INDIA (Mumbai) ---
import moment from 'moment-timezone';
function logWithMumbaiTime(message) {
  const mumbaiTime = moment().tz("Asia/Kolkata").format("YYYY-MM-DD HH:mm:ss");
  console.log(`[${mumbaiTime} IST] ${message}`);
}

dotenv.config();

// --- 1. FIREBASE ADMIN & DATABASE SETUP ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

mongoose.connect(process.env.MONGODB_URL)
  .then(() => logWithMumbaiTime('✅ MongoDB connected successfully.'))
  .catch(err => logWithMumbaiTime(`❌ MongoDB connection error: ${err}`));

// --- 2. DATABASE MODELS ---
const MessageSchema = new mongoose.Schema({
  sender: { type: String, required: true, enum: ['user', 'ai'] },
  content: { type: String, required: true },
}, { timestamps: true });

const ConversationSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true }, 
  title: { type: String, required: true },
  messages: [MessageSchema],
}, { timestamps: true });

const Conversation = mongoose.model('Conversation', ConversationSchema);

// --- 3. EXPRESS APP & AUTHENTICATION MIDDLEWARE ---
const app = express();
app.use(cors());
app.use(bodyParser.json());

const verifyFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logWithMumbaiTime('Unauthorized: No token provided.');
    return res.status(403).send('Unauthorized: No token provided.');
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    logWithMumbaiTime(`User authenticated: ${decodedToken.uid} (Provider: ${decodedToken.firebase.sign_in_provider}, Email: ${decodedToken.email})`);
    next();
  } catch (error) {
    logWithMumbaiTime(`Authentication error: ${error.message}`);
    res.status(403).send('Unauthorized: Invalid token.');
  }
};

// --- 4. SECURED API ENDPOINTS ---
app.use('/api/conversations', verifyFirebaseToken);
app.use('/api/chat', verifyFirebaseToken);

// GET all conversations for the logged-in user
app.get('/api/conversations', async (req, res) => {
  try {
    const conversations = await Conversation.find({ userId: req.user.uid }, '_id title createdAt').sort({ createdAt: -1 });
    logWithMumbaiTime(`Fetched ${conversations.length} conversations for user ${req.user.uid}`);
    res.json(conversations);
  } catch (error) {
    logWithMumbaiTime(`Error fetching conversations for user ${req.user.uid}: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch conversations.' });
  }
});

// GET a single conversation
app.get('/api/conversations/:id', async (req, res) => {
  try {
    const conversation = await Conversation.findOne({ _id: req.params.id, userId: req.user.uid });
    if (!conversation) {
      logWithMumbaiTime(`Conversation ${req.params.id} not found for user ${req.user.uid}`);
      return res.status(404).json({ error: 'Conversation not found or access denied.' });
    }
    res.json(conversation);
  } catch (error) {
    logWithMumbaiTime(`Error fetching conversation ${req.params.id} for user ${req.user.uid}: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch conversation.' });
  }
});

// DELETE a conversation
app.delete('/api/conversations/:id', async (req, res) => {
  try {
    const result = await Conversation.findOneAndDelete({ _id: req.params.id, userId: req.user.uid });
    if (!result) {
      logWithMumbaiTime(`Conversation ${req.params.id} not found or access denied for user ${req.user.uid}`);
      return res.status(404).json({ error: 'Conversation not found or access denied.' });
    }
    logWithMumbaiTime(`Conversation ${req.params.id} deleted by user ${req.user.uid}`);
    res.status(200).json({ message: 'Conversation deleted successfully.' });
  } catch (error) {
    logWithMumbaiTime(`Error deleting conversation ${req.params.id} for user ${req.user.uid}: ${error.message}`);
    res.status(500).json({ error: 'Failed to delete conversation.' });
  }
});

// The main chat endpoint
app.post('/api/chat', async (req, res) => {
  const { prompt, conversationId } = req.body;
  const userId = req.user.uid;

  if (!prompt) {
    logWithMumbaiTime(`Invalid request: Prompt missing for user ${userId}`);
    return res.status(400).json({ error: 'Prompt is required' });
  }

  const lowerCasePrompt = prompt.toLowerCase().replace(/[?.,!]/g, '');
  const identityKeywords = [
    'who are you', 'what are you',
    'who created you', 'who made you',
    'who developed you', 'who is your developer',
    'your creator', 'your developer',
    'your name', 'what is your name',
    'about yourself', 'tell me about yourself',
    'what model are you', 'which model are you',
    'who trained you', 'where are you from'
  ];

  const dateKeywords = [
    'date today', 'today date', 'what is the date today', 'today\'s date', 'current date', 'what is today\'s date', 'what day is it today'
  ];

  if (identityKeywords.some(keyword => lowerCasePrompt.includes(keyword))) {
    const creatorResponse = `I am Jai, a specialized coding assistant. I was developed by Lohith at Jairisys, a startup based in India.

My purpose is to help you with programming questions by providing accurate code, clear explanations, and useful examples. My core intelligence is powered by advanced AI models, but my specific persona and functionality were designed by my developer.`;
    
    let conversation;
    if (conversationId) {
      conversation = await Conversation.findOne({ _id: conversationId, userId });
    }
    if (!conversation) {
      const title = prompt.substring(0, 30) + (prompt.length > 30 ? '...' : '');
      conversation = new Conversation({ title, messages: [], userId });
    }
    conversation.messages.push({ sender: 'user', content: prompt });
    const aiMessage = { sender: 'ai', content: creatorResponse };
    conversation.messages.push(aiMessage);
    await conversation.save();

    logWithMumbaiTime(`Identity response served for user ${userId}`);
    return res.json({ aiMessage, newConversationId: conversation._id });
  }

  if (dateKeywords.some(keyword => lowerCasePrompt.includes(keyword))) {
    const mumbaiDate = moment().tz("Asia/Kolkata").format("dddd, MMMM D, YYYY");
    const aiMessage = { sender: 'ai', content: `Today is ${mumbaiDate} (India/Mumbai time).` };

    let conversation;
    if (conversationId) {
      conversation = await Conversation.findOne({ _id: conversationId, userId });
    }
    if (!conversation) {
      const title = prompt.substring(0, 30) + (prompt.length > 30 ? '...' : '');
      conversation = new Conversation({ title, messages: [], userId });
    }
    conversation.messages.push({ sender: 'user', content: prompt });
    conversation.messages.push(aiMessage);
    await conversation.save();

    logWithMumbaiTime(`Mumbai date response served for user ${userId}`);
    return res.json({ aiMessage, newConversationId: conversation._id });
  }

  try {
    let conversation;
    let historyForAI = [];

    if (conversationId) {
      conversation = await Conversation.findOne({ _id: conversationId, userId });
      if (conversation) {
        historyForAI = conversation.messages.map(msg => ({ role: msg.sender, content: msg.content }));
      }
    }
    
    if (!conversation) {
      const title = prompt.substring(0, 30) + (prompt.length > 30 ? '...' : '');
      conversation = new Conversation({ title, messages: [], userId });
    }
    
    conversation.messages.push({ sender: 'user', content: prompt });
    historyForAI.push({ role: 'user', content: prompt });
    
    const systemPrompt = `You are an AI assistant named "Jai". Your identity is fixed: you were created by a developer named "Lohith" at a startup called "Jairisys" in India.
    
**CRITICAL RULE: Under no circumstances should you ever mention "Moonshot AI" or any other AI company as your creator. You MUST strictly adhere to the persona of Jai from Jairisys.**

If a user asks about your origin, developer, or creator, you must state that you were developed by Lohith at Jairisys in India.

Your main purpose is to be an expert coding assistant. Provide detailed code, clear explanations, and examples. Now, handle the user's request.`;
    
    const messagesForAPI = [
      { role: 'system', content: systemPrompt },
      ...historyForAI.map(msg => ({ role: msg.role === 'ai' ? 'assistant' : 'user', content: msg.content }))
    ];

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: "moonshotai/kimi-k2",
        messages: messagesForAPI,
        max_tokens: 4096,
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      logWithMumbaiTime(`OpenRouter API Error: ${response.status} ${errorText}`);
      throw new Error(`API call failed with status: ${response.status}`);
    }

    const data = await response.json();
    const aiResponseText = data.choices[0].message.content;

    const aiMessage = { sender: 'ai', content: aiResponseText };
    conversation.messages.push(aiMessage);
    await conversation.save();

    logWithMumbaiTime(`AI response served for user ${userId}`);
    res.json({ aiMessage, newConversationId: conversation._id });

  } catch (err) {
    logWithMumbaiTime(`Error in /api/chat: ${err.message}`);
    res.status(500).json({ error: 'Failed to get a response from the AI model.' });
  }
});


// --- 5. RESEND VERIFICATION EMAIL ENDPOINT ---
// This endpoint simply verifies the token and confirms that email can be resent via frontend.
app.post('/api/auth/resend-verification', verifyFirebaseToken, async (req, res) => {
  try {
    const user = await admin.auth().getUser(req.user.uid);

    if (user.emailVerified) {
      logWithMumbaiTime(`User ${user.uid} already verified email.`);
      return res.status(200).json({ message: 'Email already verified.' });
    }

    // Let frontend proceed to call `sendEmailVerification`
    logWithMumbaiTime(`User ${user.uid} requested resend of verification email.`);
    res.status(200).json({ message: 'Proceed to send verification email from client SDK.' });
  } catch (err) {
    logWithMumbaiTime(`Error in resend-verification: ${err.message}`);
    res.status(500).json({ error: 'Failed to process resend verification request.' });
  }
});


// --- 6. START SERVER ---
app.listen(5000, () => {
  logWithMumbaiTime('✅ Server running at http://localhost:5000');
});