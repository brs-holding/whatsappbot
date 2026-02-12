# WhatsApp Messager v2.0

AI-powered WhatsApp automation with human-like messaging behavior.

## Features

- **Human-Like Messaging**: Messages are split into short chunks (max 70 chars) with natural delays
- **AI Auto-Reply**: Automatically responds to incoming messages using OpenAI GPT
- **Knowledge Base**: Store company info, FAQs, and context for better responses
- **Contact Management**: Organize contacts with tags, notes, and conversation history
- **Message Templates**: Reusable templates with personalization variables
- **Conversation Tracking**: Full history of all conversations

## Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/whatsapp-messager.git
cd whatsapp-messager

# Install dependencies
npm install

# Copy environment file and add your OpenAI API key
cp .env.example .env

# Run the application
npm start
```

## Configuration

1. Copy `.env.example` to `.env`
2. Add your OpenAI API key for AI features
3. Run `npm start` and scan the QR code with WhatsApp

## Usage

### Main Menu Options

- **Send Message**: Send a message to any contact (auto-split if too long)
- **Contact Manager**: Add, list, search, and manage contacts
- **Knowledge Base**: Store information for AI to use in responses
- **Message Templates**: Create reusable message templates
- **View Conversations**: See full conversation history
- **Settings**: Toggle auto-reply, typing indicators, etc.

### Human-Like Behavior

The app mimics human behavior:
- Messages over 70 characters are split into shorter messages
- Random delays between messages (2-8 seconds)
- Typing indicators before sending
- Natural conversation flow

### Knowledge Base

Add information that the AI will use when responding:
- Company information
- Pricing details
- Service descriptions
- FAQs

The AI searches the knowledge base for relevant info before responding.

## Project Structure

```
whatsapp-messager/
├── src/
│   ├── index.js          # Main application
│   ├── database/
│   │   └── db.js         # SQLite database
│   ├── humanizer/
│   │   └── index.js      # Message splitting & delays
│   └── ai/
│       └── index.js      # OpenAI integration
├── data/                  # SQLite database files
├── .env.example          # Environment template
└── package.json
```

## Requirements

- Node.js 18+
- Chrome or Edge browser
- OpenAI API key (for AI features)
- WhatsApp account

## License

MIT