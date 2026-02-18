import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import admin from 'firebase-admin';
import Groq from 'groq-sdk';
import moment from 'moment-timezone';

// --- 0. TIMEZONE UTILITY FOR INDIA (Mumbai) ---
function logWithMumbaiTime(message) {
  const mumbaiTime = moment().tz("Asia/Kolkata").format("YYYY-MM-DD HH:mm:ss");
  console.log(`[${mumbaiTime} IST] ${message}`);
}

dotenv.config();

// --- 1. GROQ CLIENT SETUP ---
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// --- 2. FIREBASE ADMIN & DATABASE SETUP ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

mongoose.connect(process.env.MONGODB_URL)
  .then(() => logWithMumbaiTime('✅ MongoDB connected successfully.'))
  .catch(err => logWithMumbaiTime(`❌ MongoDB connection error: ${err}`));

// --- 3. DATABASE MODELS ---
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

// --- 4. UTILITY FOR CROSS-CHAT KNOWLEDGE (MEMORY) ---
async function getUserLongTermMemory(userId, currentConversationId) {
  try {
    // Fetch last 5 conversations (excluding current one) to provide context/memory
    const pastConversations = await Conversation.find({ 
      userId, 
      _id: { $ne: currentConversationId } 
    })
    .sort({ updatedAt: -1 })
    .limit(5);

    if (pastConversations.length === 0) return "User has no previous conversation history.";

    let historySummary = "CONTEXT FROM USER'S PREVIOUS CHATS (Knowledge Retrieval):\n";
    pastConversations.forEach((conv) => {
      const lastMsg = conv.messages[conv.messages.length - 1];
      historySummary += `- Topic: "${conv.title}". `;
      if (lastMsg) {
        historySummary += `Last Exchange: ${lastMsg.sender}: "${lastMsg.content.substring(0, 150)}..."`;
      }
      historySummary += "\n";
    });
    return historySummary;
  } catch (error) {
    return "Error retrieving past history.";
  }
}

// --- 5. EXPRESS APP & AUTHENTICATION MIDDLEWARE ---
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
    logWithMumbaiTime(`User authenticated: ${decodedToken.uid}`);
    next();
  } catch (error) {
    logWithMumbaiTime(`Authentication error: ${error.message}`);
    res.status(403).send('Unauthorized: Invalid token.');
  }
};

// --- 6. API ENDPOINTS ---
app.use('/api/conversations', verifyFirebaseToken);
app.use('/api/chat', verifyFirebaseToken);

app.get('/api/conversations', async (req, res) => {
  try {
    const conversations = await Conversation.find({ userId: req.user.uid }, '_id title createdAt').sort({ createdAt: -1 });
    res.json(conversations);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch conversations.' });
  }
});

app.get('/api/conversations/:id', async (req, res) => {
  try {
    const conversation = await Conversation.findOne({ _id: req.params.id, userId: req.user.uid });
    if (!conversation) return res.status(404).json({ error: 'Conversation not found.' });
    res.json(conversation);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch conversation.' });
  }
});

app.delete('/api/conversations/:id', async (req, res) => {
  try {
    const result = await Conversation.findOneAndDelete({ _id: req.params.id, userId: req.user.uid });
    if (!result) return res.status(404).json({ error: 'Conversation not found.' });
    res.status(200).json({ message: 'Conversation deleted successfully.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete conversation.' });
  }
});

// The Main Chat Endpoint
app.post('/api/chat', async (req, res) => {
  const { prompt, conversationId } = req.body;
  const userId = req.user.uid;

  if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

  const lowerCasePrompt = prompt.toLowerCase().replace(/[?.,!]/g, '');
  
  // Shortcut Keywords (Identity & Date)
  const identityKeywords = ['who are you', 'what are you', 'who created you', 'who made you', 'who developed you', 'who is your developer', 'your creator', 'your developer', 'your name', 'what is your name', 'about yourself', 'tell me about yourself', 'what model are you', 'which model are you', 'who trained you', 'where are you from'];
  const dateKeywords = ['date today', 'today date', 'what is the date today', "today's date", 'current date', "what is today's date", 'what day is it today'];

  if (identityKeywords.some(keyword => lowerCasePrompt.includes(keyword))) {
    const creatorResponse = `I am Jai, a specialized coding assistant. I was developed by Jairisys, a startup based in India. My purpose is to help you with programming questions by providing accurate code, clear explanations, and useful examples. My core intelligence is powered by advanced AI models, but my specific persona and functionality were designed by my developer.`;
    return handleShortcutResponse(res, userId, conversationId, prompt, creatorResponse);
  }

  if (dateKeywords.some(keyword => lowerCasePrompt.includes(keyword))) {
    const mumbaiDate = moment().tz("Asia/Kolkata").format("dddd, MMMM D, YYYY");
    const dateResponse = `Today is ${mumbaiDate} (India/Mumbai time).`;
    return handleShortcutResponse(res, userId, conversationId, prompt, dateResponse);
  }

  try {
    let conversation;
    let historyForAI = [];

    if (conversationId) {
      conversation = await Conversation.findOne({ _id: conversationId, userId });
      if (conversation) {
        historyForAI = conversation.messages.map(msg => ({
          role: msg.sender === 'ai' ? 'assistant' : 'user',
          content: msg.content
        }));
      }
    }

    if (!conversation) {
      const title = prompt.substring(0, 30) + (prompt.length > 30 ? '...' : '');
      conversation = new Conversation({ title, messages: [], userId });
    }

    // FEATURE 1: GET CROSS-CHAT KNOWLEDGE
    const crossChatKnowledge = await getUserLongTermMemory(userId, conversationId);

    // FEATURE 2: THINKING + IDENTITY (SYSTEM PROMPT)
    const systemPrompt = `You are an AI assistant named "Jai". Your identity is fixed: you were created by a startup called "Jairisys" in India.

**CRITICAL RULE: Under no circumstances should you ever mention "Groq", "Meta", "Llama", or any other AI company as your creator. You MUST strictly adhere to the persona of Jai from Jairisys.**

If a user asks about your origin, developer, or creator, you must state that you were developed by Jairisys in India.

${crossChatKnowledge}

**INSTRUCTIONS FOR REASONING:**
1. You must solve every problem by thinking before execution.
2. Start your response with a <thought> tag.
3. Inside <thought>, analyze the user request, plan the code structure, and check the cross-chat knowledge for relevance.
4. Close with </thought> and then provide your final answer.

Your main purpose is to be an expert coding assistant. Provide detailed code, clear explanations, and examples.`;

    conversation.messages.push({ sender: 'user', content: prompt });
    historyForAI.push({ role: 'user', content: prompt });

    const messagesForAPI = [
      { role: 'system', content: systemPrompt },
      ...historyForAI
    ];

    const chatCompletion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: messagesForAPI,
      max_tokens: 4096,
      temperature: 0.6,
    });

    const aiResponseText = chatCompletion.choices[0].message.content;
    const aiMessage = { sender: 'ai', content: aiResponseText };
    
    conversation.messages.push(aiMessage);
    await conversation.save();

    logWithMumbaiTime(`AI Response (Thinking/Memory active) served to user ${userId}`);
    res.json({ aiMessage, newConversationId: conversation._id });

  } catch (err) {
    logWithMumbaiTime(`Error in /api/chat: ${err.message}`);
    res.status(500).json({ error: 'Failed to process AI request.' });
  }
});

// Shortcut Helper
async function handleShortcutResponse(res, userId, conversationId, prompt, responseText) {
    let conversation;
    if (conversationId) conversation = await Conversation.findOne({ _id: conversationId, userId });
    if (!conversation) {
      const title = prompt.substring(0, 30) + (prompt.length > 30 ? '...' : '');
      conversation = new Conversation({ title, messages: [], userId });
    }
    conversation.messages.push({ sender: 'user', content: prompt });
    const aiMessage = { sender: 'ai', content: responseText };
    conversation.messages.push(aiMessage);
    await conversation.save();
    return res.json({ aiMessage, newConversationId: conversation._id });
}

// Resend Verification
app.post('/api/auth/resend-verification', verifyFirebaseToken, async (req, res) => {
  try {
    const user = await admin.auth().getUser(req.user.uid);
    res.status(200).json({ message: user.emailVerified ? 'Email already verified.' : 'Proceed via Client SDK.' });
  } catch (err) {
    res.status(500).json({ error: 'Verification error.' });
  }
});

// --- 7. START SERVER ---
app.listen(5000, () => {
  logWithMumbaiTime('✅ Server running at http://localhost:5000');
});
