import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth';
import { api, errorMessage, type User } from '../api';
import { Alert, Avatar, Empty, Spinner } from '../components';

type ChatThread = {
  id: string;
  participant: User | null;
  lastMessage: { id: string; senderId: string; content: string; createdAt: string } | null;
  updatedAt: string;
};

type ChatMessage = {
  id: string;
  senderId: string;
  sender: { id: string; fullName: string; username: string; role: string } | null;
  content: string;
  createdAt: string;
};

export function ChatPage() {
  const { me } = useAuth();
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [contacts, setContacts] = useState<User[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadThreads = async () => {
    const data = await api<{ threads: ChatThread[] }>('/chats');
    setThreads(data.threads);
    if (!selectedThreadId && data.threads[0]) setSelectedThreadId(data.threads[0].id);
    if (selectedThreadId && !data.threads.some((thread) => thread.id === selectedThreadId)) {
      setSelectedThreadId(data.threads[0]?.id ?? null);
    }
  };

  const loadContacts = async () => {
    const data = await api<{ contacts: User[] }>('/chat/contacts');
    setContacts(data.contacts);
  };

  const selectedThread = useMemo(() => threads.find((thread) => thread.id === selectedThreadId) ?? null, [selectedThreadId, threads]);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        await Promise.all([loadThreads(), loadContacts()]);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, []);

  useEffect(() => {
    if (!selectedThreadId) {
      setMessages([]);
      return;
    }

    const loadMessages = async () => {
      try {
        const data = await api<{ messages: ChatMessage[] }>('/chats/' + selectedThreadId + '/messages');
        setMessages(data.messages);
      } catch (err) {
        setError(errorMessage(err));
      }
    };

    void loadMessages();
  }, [selectedThreadId]);

  const startThread = async (participantId: string) => {
    try {
      setError(null);
      const data = await api<{ thread: ChatThread }>('/chats', { method: 'POST', body: { participantId } });
      await loadThreads();
      setSelectedThreadId(data.thread.id);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const sendMessage = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedThreadId || !draft.trim()) return;
    setSending(true);
    setError(null);
    try {
      const payload = await api<{ message: { id: string; senderId: string; content: string; createdAt: string } }>('/chats/' + selectedThreadId + '/messages', {
        method: 'POST',
        body: { content: draft.trim() },
      });
      setMessages((current) => [
        ...current,
        {
          id: payload.message.id,
          senderId: payload.message.senderId,
          sender: { id: '', fullName: 'You', username: '', role: 'student' },
          content: payload.message.content,
          createdAt: payload.message.createdAt,
        },
      ]);
      setDraft('');
      await loadThreads();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  if (loading) return <Spinner label="Loading chats…" />;

  return (
    <section className="chat-page card">
      <div className="chat-header">
        <div>
          <h1>Direct messages</h1>
          <p className="muted">Contact organizers, faculty, or other volunteers without sharing personal contact details.</p>
        </div>
      </div>

      {error && <Alert kind="error">{error}</Alert>}

      <div className="chat-layout">
        <aside className="chat-sidebar">
          <div className="chat-sidebar-header">
            <strong>Recent conversations</strong>
          </div>
          <div className="chat-thread-list">
            {threads.length === 0 ? (
              <Empty title="No conversations yet">Start a message with a teammate or organizer.</Empty>
            ) : (
              threads.map((thread) => {
                const other = thread.participant;
                return (
                  <button
                    key={thread.id}
                    type="button"
                    className={`chat-thread-item${selectedThreadId === thread.id ? ' active' : ''}`}
                    onClick={() => setSelectedThreadId(thread.id)}
                  >
                    <div className="chat-thread-avatar"><Avatar user={{ id: other?.id ?? '', fullName: other?.fullName ?? 'Unknown', hasPhoto: Boolean(other?.hasPhoto) }} /></div>
                    <div className="chat-thread-copy">
                      <span className="chat-thread-name">{other?.fullName ?? 'Unknown user'}</span>
                      <span className="chat-thread-preview">{thread.lastMessage?.content ?? 'No messages yet'}</span>
                    </div>
                  </button>
                );
              })
            )}
          </div>

          <div className="chat-contact-panel">
            <strong>Start a chat</strong>
            <div className="chat-contact-list">
              {contacts.filter((person) => person.id !== selectedThread?.participant?.id).map((person) => (
                <button key={person.id} type="button" className="chat-contact" onClick={() => void startThread(person.id)}>
                  <Avatar user={{ id: person.id, fullName: person.fullName, hasPhoto: person.hasPhoto }} />
                  <span>{person.fullName}</span>
                  <small>{person.role}</small>
                </button>
              ))}
            </div>
          </div>
        </aside>

        <div className="chat-panel">
          {selectedThread ? (
            <>
              <header className="chat-panel-header">
                <div className="chat-thread-avatar large"><Avatar user={{ id: selectedThread.participant?.id ?? '', fullName: selectedThread.participant?.fullName ?? 'Unknown', hasPhoto: Boolean(selectedThread.participant?.hasPhoto) }} /></div>
                <div>
                  <strong>{selectedThread.participant?.fullName ?? 'Unknown user'}</strong>
                  <div className="muted">{selectedThread.participant?.role ?? 'User'}</div>
                </div>
              </header>

              <div className="chat-messages">
                {messages.length === 0 ? (
                  <div className="chat-empty">Send the first message to start the conversation.</div>
                ) : (
                  messages.map((message) => {
                    const mine = !!me && message.senderId === me.user.id;
                    return (
                      <div key={message.id} className={`chat-bubble ${mine ? 'mine' : 'theirs'}`}>
                        <p>{message.content}</p>
                        <span>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                      </div>
                    );
                  })
                )}
              </div>

              <form className="chat-composer" onSubmit={sendMessage}>
                <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} placeholder="Write a message…" />
                <button type="submit" className="btn btn-primary" disabled={sending || !draft.trim()}>
                  {sending ? 'Sending…' : 'Send message'}
                </button>
              </form>
            </>
          ) : (
            <div className="chat-empty-state">
              <strong>No thread selected</strong>
              <p>Pick a conversation or start a new chat from the left panel.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}