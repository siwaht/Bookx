import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { books, chapters as chaptersApi, importManuscript, uploadAudioToChapter } from '../services/api';
import { toast } from '../components/Toast';
import type { Book } from '../types';
import { ArrowRight, BookOpen, Check, Headphones, Loader, Mic, Plus, Upload, Trash2 } from 'lucide-react';
import { CardSkeleton } from '../components/ui/Skeleton';

export function Dashboard() {
  const [bookList, setBookList] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState('');
  const [author, setAuthor] = useState('');
  const [projectType, setProjectType] = useState<'audiobook' | 'podcast'>('audiobook');
  const [format, setFormat] = useState('single_narrator');
  const [showUpload, setShowUpload] = useState(false);
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadAuthor, setUploadAuthor] = useState('');
  const [uploadProjectType, setUploadProjectType] = useState<'audiobook' | 'podcast'>('audiobook');
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState('');
  const [createStep, setCreateStep] = useState<1 | 2 | 3>(1);
  const [defaultModel, setDefaultModel] = useState('eleven_multilingual_v2');
  const [manuscriptFile, setManuscriptFile] = useState<File | null>(null);
  const [creating, setCreating] = useState(false);
  const uploadFileRef = useRef<HTMLInputElement>(null);
  const manuscriptFileRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const loadBooks = async () => {
    try {
      const data = await books.list();
      setBookList(Array.isArray(data) ? data : []);
    } catch (err: any) {
      console.error('Failed to load books:', err);
      toast.error('Could not load your projects. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadBooks(); }, []);

  const openCreate = () => {
    setShowUpload(false);
    setCreateStep(1);
    setManuscriptFile(null);
    setShowCreate(true);
  };

  const openUpload = () => {
    setShowCreate(false);
    setShowUpload(true);
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (createStep === 1 && !title.trim()) return;
    if (createStep < 3) {
      setCreateStep((step) => (step + 1) as 1 | 2 | 3);
      return;
    }
    setCreating(true);
    try {
      const book = await books.create({
        title: title.trim(),
        author: author.trim(),
        project_type: projectType,
        format,
        default_model: defaultModel,
      });
      if (manuscriptFile) {
        setUploadProgress('Parsing your manuscript…');
        await importManuscript(book.id, manuscriptFile);
      }
      setTitle('');
      setAuthor('');
      setManuscriptFile(null);
      setShowCreate(false);
      setCreateStep(1);
      navigate(`/book/${book.id}`);
    } catch (err: any) {
      toast.error(`Failed to create project: ${err.message}`);
    } finally {
      setCreating(false);
      setUploadProgress('');
    }
  };

  const handleDelete = async (id: string, bookTitle: string, e: MouseEvent) => {
    e.stopPropagation();
    if (confirm(`Delete "${bookTitle}" and all its audio data? This cannot be undone.`)) {
      await books.delete(id);
      loadBooks();
    }
  };

  const handleUploadExisting = async (e: FormEvent) => {
    e.preventDefault();
    if (!uploadTitle.trim() || uploadFiles.length === 0) return;
    setUploading(true);
    setUploadProgress('Creating project…');
    try {
      const book = await books.create({
        title: uploadTitle.trim(),
        author: uploadAuthor.trim(),
        project_type: uploadProjectType,
        format: 'single_narrator',
      } as any);
      for (let i = 0; i < uploadFiles.length; i++) {
        const file = uploadFiles[i];
        const chapterTitle = uploadFiles.length === 1 ? 'Full Audio' : `Chapter ${i + 1} — ${file.name.replace(/\.[^.]+$/, '')}`;
        setUploadProgress(`Uploading file ${i + 1} of ${uploadFiles.length}…`);
        const chapter = await chaptersApi.create(book.id, { title: chapterTitle, raw_text: `[Imported audio: ${file.name}]` });
        await uploadAudioToChapter(book.id, chapter.id, file);
      }
      setUploadTitle('');
      setUploadAuthor('');
      setUploadFiles([]);
      setShowUpload(false);
      navigate(`/book/${book.id}`);
    } catch (err: any) {
      toast.error(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
      setUploadProgress('');
    }
  };

  return (
    <div className="dashboard-page" style={styles.page}>
      <header className="page-heading animate-in" style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={styles.eyebrow}><span style={styles.eyebrowDot} /> Your studio</div>
          <h1 style={styles.h1}>Make something people can hear.</h1>
          <p style={styles.subtitle}>Create, shape, and publish audiobooks or podcasts in one calm workspace.</p>
        </div>
        <div className="dashboard-actions" style={styles.headerActions}>
          <button onClick={openCreate} style={styles.createBtn}><Plus size={16} /> New project</button>
          <button onClick={openUpload} style={styles.uploadBtn}><Upload size={15} /> Import audio</button>
        </div>
      </header>

      <section style={styles.introCard} className="simple-card animate-slide-up">
        <div style={styles.introIcon}><Headphones size={23} /></div>
        <div style={{ flex: 1 }}>
          <h2 style={styles.introTitle}>A simple path from words to sound</h2>
          <p style={styles.introText}>Start with a manuscript or existing audio. Bookx keeps the next useful action close at hand.</p>
        </div>
        <div style={styles.introSteps} aria-label="Getting started steps">
          {['Start', 'Shape', 'Publish'].map((step, index) => (
            <div key={step} style={styles.introStep}><span style={styles.stepNumber}>{index + 1}</span><span>{step}</span></div>
          ))}
        </div>
      </section>

      {(showCreate || showUpload) && (
        <section style={styles.formCard} className="animate-in-scale">
          <div style={styles.formHeader}>
            <div>
              <div style={styles.formEyebrow}>{showUpload ? 'Import existing audio' : 'Start a new project'}</div>
              <h2 style={styles.formTitle}>{showUpload ? 'Bring your audio into Bookx' : 'What are you making?'}</h2>
            </div>
            <button type="button" onClick={() => { setShowCreate(false); setShowUpload(false); }} style={styles.closeBtn} aria-label="Close form">×</button>
          </div>
          {showCreate ? (
            <form onSubmit={handleCreate} style={styles.formBody}>
              <div style={styles.stepper} aria-label="Audiobook setup progress">
                {[['1', 'Basics'], ['2', 'Narration'], ['3', 'Review']].map(([step, label]) => (
                  <div key={step} style={{ ...styles.stepItem, ...(createStep >= Number(step) ? styles.stepItemActive : {}) }}><span style={styles.stepCircle}>{createStep > Number(step) ? '✓' : step}</span><span>{label}</span></div>
                ))}
              </div>
              {createStep === 1 && <>
                <div style={styles.typeToggle} role="group" aria-label="Project type">
                  <button type="button" onClick={() => { setProjectType('audiobook'); setFormat('single_narrator'); }} style={{ ...styles.typeBtn, ...(projectType === 'audiobook' ? styles.typeBtnActive : {}) }}>
                    <BookOpen size={17} /><span><strong>Audiobook</strong><small>Long-form narration</small></span>
                  </button>
                  <button type="button" onClick={() => { setProjectType('podcast'); setFormat('two_person_conversation'); }} style={{ ...styles.typeBtn, ...(projectType === 'podcast' ? styles.typeBtnActive : {}) }}>
                    <Mic size={17} /><span><strong>Podcast</strong><small>Episodes and conversations</small></span>
                  </button>
                </div>
                <div style={styles.formGrid}>
                  <label style={styles.field}><span>{projectType === 'podcast' ? 'Episode title' : 'Book title'}</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={projectType === 'podcast' ? 'e.g. The first conversation' : 'e.g. The quiet morning'} autoFocus aria-label="Project title" /></label>
                  <label style={styles.field}><span>{projectType === 'podcast' ? 'Host name' : 'Author'} <em>optional</em></span><input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Add a name" aria-label="Author or host" /></label>
                </div>
                <label style={styles.field}><span>Narration style</span><select value={format} onChange={(e) => setFormat(e.target.value)} aria-label="Narration style">
                  {projectType === 'audiobook' ? <><option value="single_narrator">Single cast — one narrator</option><option value="multi_character">Multi cast — narrator + characters</option><option value="conversation_with_narrator">Characters + narrator</option></> : <><option value="two_person_conversation">Two people conversing</option><option value="narrator_and_guest">Host + guest(s)</option><option value="interview">Interview</option><option value="single_narrator">Solo speaker</option><option value="multi_character">Panel / multi-speaker</option></>}
                </select></label>
              </>}
              {createStep === 2 && <>
                <div style={styles.formGrid}>
                  <label style={styles.field}><span>Voice model</span><select value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} aria-label="Voice model"><option value="eleven_multilingual_v2">Multilingual v2 — natural narration</option><option value="eleven_v3">Eleven v3 — expressive direction</option><option value="eleven_flash_v2_5">Flash — faster drafts</option></select></label>
                  <label style={styles.field}><span>Language</span><select defaultValue="auto" aria-label="Language"><option value="auto">Auto-detect from manuscript</option><option value="en">English</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option></select></label>
                </div>
                <div style={styles.uploadDropzone} onClick={() => manuscriptFileRef.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') manuscriptFileRef.current?.click(); }}>
                  <Upload size={20} />
                  <strong>{manuscriptFile ? manuscriptFile.name : 'Upload your manuscript'}</strong>
                  <span>{manuscriptFile ? `${(manuscriptFile.size / (1024 * 1024)).toFixed(1)} MB selected` : 'EPUB, DOCX, TXT, Markdown, or HTML — optional for now'}</span>
                  <input ref={manuscriptFileRef} type="file" accept=".txt,.md,.docx,.epub,.html,.htm" hidden onChange={(e) => setManuscriptFile(e.target.files?.[0] || null)} aria-label="Upload manuscript" />
                </div>
                <p style={styles.formHint}>Bookx will parse chapters and sections, then let you review the structure before generating narration.</p>
              </>}
              {createStep === 3 && <div style={styles.reviewCard}>
                <div style={styles.reviewLine}><span>Project</span><strong>{title || 'Untitled project'}</strong></div>
                <div style={styles.reviewLine}><span>Type</span><strong>{projectType === 'audiobook' ? 'Audiobook' : 'Podcast'} · {format.replace(/_/g, ' ')}</strong></div>
                <div style={styles.reviewLine}><span>Voice model</span><strong>{defaultModel.replace(/_/g, ' ')}</strong></div>
                <div style={styles.reviewLine}><span>Manuscript</span><strong>{manuscriptFile ? manuscriptFile.name : 'Add later from Write'}</strong></div>
              </div>}
              {uploadProgress && <div style={styles.progressText}><Loader size={14} className="spin" /> {uploadProgress}</div>}
              <div style={styles.formActions}><button type="submit" disabled={creating || (createStep === 1 && !title.trim())} style={{ ...styles.submitBtn, opacity: creating || (createStep === 1 && !title.trim()) ? 0.5 : 1 }}>{creating ? 'Creating…' : createStep < 3 ? 'Continue' : projectType === 'audiobook' ? 'Create audiobook' : 'Create podcast'} <ArrowRight size={15} /></button>{createStep > 1 && <button type="button" onClick={() => setCreateStep((step) => (step - 1) as 1 | 2 | 3)} style={styles.cancelBtn}>Back</button>}<button type="button" onClick={() => { setShowCreate(false); setCreateStep(1); }} style={styles.cancelBtn}>Cancel</button></div>
            </form>
          ) : (
            <form onSubmit={handleUploadExisting} style={styles.formBody}>
              <p style={styles.formHint}>Upload one file for a single episode, or several files to create chapters automatically.</p>
              <div style={styles.formGrid}>
                <label style={styles.field}><span>{uploadProjectType === 'podcast' ? 'Episode title' : 'Book title'}</span><input value={uploadTitle} onChange={(e) => setUploadTitle(e.target.value)} placeholder="Give it a clear name" autoFocus aria-label="Project title" /></label>
                <label style={styles.field}><span>{uploadProjectType === 'podcast' ? 'Host name' : 'Author'} <em>optional</em></span><input value={uploadAuthor} onChange={(e) => setUploadAuthor(e.target.value)} placeholder="Add a name" aria-label="Author or host" /></label>
              </div>
              <div style={styles.typeToggle} role="group" aria-label="Imported project type">
                <button type="button" onClick={() => setUploadProjectType('audiobook')} style={{ ...styles.typeBtn, ...(uploadProjectType === 'audiobook' ? styles.typeBtnActive : {}) }}><BookOpen size={17} /><span><strong>Audiobook</strong><small>Chapters</small></span></button>
                <button type="button" onClick={() => setUploadProjectType('podcast')} style={{ ...styles.typeBtn, ...(uploadProjectType === 'podcast' ? styles.typeBtnActive : {}) }}><Mic size={17} /><span><strong>Podcast</strong><small>Episodes</small></span></button>
              </div>
              <div style={styles.field}><span>Audio files</span><button type="button" onClick={() => uploadFileRef.current?.click()} style={styles.filePicker}><Upload size={16} /><span>{uploadFiles.length > 0 ? `${uploadFiles.length} file${uploadFiles.length > 1 ? 's' : ''} selected` : 'Choose MP3, WAV, M4A, FLAC…'}</span></button><input ref={uploadFileRef} type="file" accept=".mp3,.wav,.ogg,.m4a,.flac,.aac" multiple onChange={(e) => setUploadFiles(Array.from(e.target.files || []))} hidden aria-label="Select audio files" />{uploadFiles.length > 0 && <div style={styles.fileList}>{uploadFiles.map((file, index) => <div key={`${file.name}-${index}`}><Check size={12} /> {file.name} <span>({(file.size / (1024 * 1024)).toFixed(1)} MB)</span></div>)}</div>}</div>
              {uploadProgress && <div style={styles.progressText}><Loader size={14} className="spin" /> {uploadProgress}</div>}
              <div style={styles.formActions}><button type="submit" disabled={uploading || !uploadTitle.trim() || uploadFiles.length === 0} style={{ ...styles.submitBtn, background: 'linear-gradient(135deg, #7358b8, #9a74d2)', opacity: uploading || !uploadTitle.trim() || uploadFiles.length === 0 ? 0.5 : 1 }}>{uploading ? 'Importing…' : 'Import project'} <ArrowRight size={15} /></button><button type="button" onClick={() => { setShowUpload(false); setUploadFiles([]); }} style={styles.cancelBtn} disabled={uploading}>Cancel</button></div>
            </form>
          )}
        </section>
      )}

      <div style={styles.sectionHeader}>
        <div><div style={styles.sectionEyebrow}>Your work</div><h2 style={styles.sectionTitle}>{bookList.length ? 'Recent projects' : 'Your projects'}</h2></div>
        {bookList.length > 0 && <span style={styles.count}>{bookList.length} project{bookList.length === 1 ? '' : 's'}</span>}
      </div>

      {loading && <div className="project-grid" style={styles.grid}>{[1, 2, 3].map((i) => <CardSkeleton key={i} />)}</div>}

      {!loading && bookList.length > 0 && <div className="project-grid stagger-children" style={styles.grid}>{bookList.map((book) => {
        const isPodcast = book.project_type === 'podcast';
        return <div key={book.id} onClick={() => navigate(`/book/${book.id}`)} style={styles.card} className="card-hover" role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && navigate(`/book/${book.id}`)}>
          <div style={styles.cardTop}><div style={{ ...styles.cardIconWrap, background: isPodcast ? 'var(--purple-subtle)' : 'var(--accent-subtle)', color: isPodcast ? 'var(--purple)' : 'var(--accent)' }}>{isPodcast ? <Mic size={19} /> : <BookOpen size={19} />}<span style={styles.cardIconHalo} /></div><button onClick={(e) => handleDelete(book.id, book.title, e)} style={styles.deleteBtn} aria-label={`Delete ${book.title}`}><Trash2 size={14} /></button></div>
          <div style={styles.cardContent}><h3 style={styles.cardTitle}>{book.title}</h3>{book.author && <p style={styles.cardAuthor}>{book.author}</p>}</div>
          <div style={styles.cardFooter}><span style={{ ...styles.badge, color: isPodcast ? 'var(--purple)' : 'var(--accent)', background: isPodcast ? 'var(--purple-subtle)' : 'var(--accent-subtle)' }}>{isPodcast ? 'Podcast' : 'Audiobook'}</span><span style={styles.cardDate}>{new Date(book.created_at).toLocaleDateString()}</span><ArrowRight size={15} style={{ color: 'var(--accent)', marginLeft: 'auto' }} /></div>
        </div>;
      })}</div>}

      {!loading && bookList.length === 0 && !showCreate && !showUpload && <section style={styles.emptyState} className="simple-card animate-in"><div style={styles.emptyIconWrap}><Headphones size={29} /></div><h2 style={styles.emptyTitle}>Your first project starts here</h2><p style={styles.emptyText}>Choose a project type and Bookx will guide you through importing content, choosing voices, generating audio, and exporting the finished work.</p><div style={styles.emptyActions}><button onClick={openCreate} style={styles.submitBtn}><Plus size={16} /> Create a project</button><button onClick={openUpload} style={styles.cancelBtn}><Upload size={16} /> Import audio</button></div><div style={styles.emptySteps}>{['Start with a book or podcast', 'Add words, voices, and sound', 'Listen, refine, and export'].map((step, index) => <div key={step} style={styles.emptyStep}><span style={styles.stepDot}>{index + 1}</span><span>{step}</span></div>)}</div></section>}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  page: { padding: '38px clamp(18px, 5vw, 64px) 64px', maxWidth: 1180, margin: '0 auto', minHeight: '100%', overflow: 'auto' },
  header: { marginBottom: 26 },
  headerLeft: { maxWidth: 620 },
  eyebrow: { display: 'flex', alignItems: 'center', gap: 7, color: 'var(--accent)', fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 12 },
  eyebrowDot: { width: 7, height: 7, borderRadius: '50%', background: 'var(--success)', boxShadow: '0 0 0 4px var(--success-subtle)' },
  h1: { fontSize: 'clamp(28px, 4vw, 44px)', lineHeight: 1.08, fontWeight: 700, letterSpacing: '-0.05em', color: 'var(--text-primary)', maxWidth: 560 },
  subtitle: { fontSize: 15, color: 'var(--text-secondary)', marginTop: 13, lineHeight: 1.6, maxWidth: 520 },
  headerActions: { display: 'flex', gap: 9, alignItems: 'center', paddingTop: 8 },
  createBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '11px 17px', background: 'var(--accent-gradient)', color: '#fff', border: 'none', borderRadius: 11, cursor: 'pointer', fontSize: 13, fontWeight: 700, boxShadow: '0 7px 18px rgba(40,123,181,0.20)' },
  uploadBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '11px 15px', background: 'var(--bg-surface)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)', borderRadius: 11, cursor: 'pointer', fontSize: 13, fontWeight: 600 },
  introCard: { display: 'flex', alignItems: 'center', gap: 16, padding: '17px 19px', marginBottom: 34, background: 'linear-gradient(135deg, rgba(255,255,255,0.88), rgba(240,248,249,0.86))' },
  introIcon: { width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 13, color: 'var(--accent)', background: 'var(--accent-subtle)', flexShrink: 0 },
  introTitle: { fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' },
  introText: { fontSize: 12, color: 'var(--text-tertiary)', marginTop: 3 },
  introSteps: { display: 'flex', alignItems: 'center', gap: 14, marginLeft: 'auto', color: 'var(--text-secondary)', fontSize: 11, fontWeight: 600 },
  introStep: { display: 'flex', alignItems: 'center', gap: 6 },
  stepNumber: { width: 22, height: 22, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-base)', color: 'var(--accent)', border: '1px solid var(--border-accent)', fontSize: 10 },
  formCard: { maxWidth: 760, padding: 24, marginBottom: 34, background: 'rgba(255,255,255,0.94)', border: '1px solid var(--border-accent)', borderRadius: 18, boxShadow: 'var(--shadow-lg)' },
  formHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 20 },
  formEyebrow: { color: 'var(--accent)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 6 },
  formTitle: { color: 'var(--text-primary)', fontSize: 20, fontWeight: 700, letterSpacing: '-0.03em' },
  closeBtn: { width: 30, height: 30, background: 'var(--bg-elevated)', color: 'var(--text-tertiary)', border: 'none', borderRadius: 9, cursor: 'pointer', fontSize: 21, lineHeight: 1 },
  formBody: { display: 'flex', flexDirection: 'column', gap: 16 },
  stepper: { display: 'flex', alignItems: 'center', gap: 10, padding: '2px 0 6px', borderBottom: '1px solid var(--border-subtle)' },
  stepItem: { display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontSize: 11, fontWeight: 600 },
  stepItemActive: { color: 'var(--accent)' },
  stepCircle: { width: 22, height: 22, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', fontSize: 10 },
  uploadDropzone: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '28px 18px', color: 'var(--accent)', background: 'linear-gradient(135deg, var(--accent-subtle), rgba(60,155,155,0.08))', border: '1px dashed var(--border-accent)', borderRadius: 14, cursor: 'pointer', textAlign: 'center' },
  reviewCard: { display: 'flex', flexDirection: 'column', gap: 0, border: '1px solid var(--border-default)', borderRadius: 12, overflow: 'hidden', background: 'var(--bg-elevated)' },
  reviewLine: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 20, padding: '13px 15px', color: 'var(--text-tertiary)', fontSize: 12, borderBottom: '1px solid var(--border-subtle)' },
  formHint: { color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.55, marginTop: -4 },
  typeToggle: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 },
  typeBtn: { display: 'flex', alignItems: 'center', gap: 10, padding: 13, textAlign: 'left', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)', borderRadius: 12, cursor: 'pointer' },
  typeBtnActive: { background: 'var(--accent-subtle)', color: 'var(--accent)', borderColor: 'var(--border-accent)', boxShadow: '0 5px 15px rgba(40,123,181,0.08)' },
  formGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 },
  field: { display: 'flex', flexDirection: 'column', gap: 7, color: 'var(--text-secondary)', fontSize: 11, fontWeight: 700 },
  input: {},
  formActions: { display: 'flex', alignItems: 'center', gap: 9, marginTop: 2 },
  submitBtn: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 15px', background: 'var(--accent-gradient)', color: '#fff', border: 'none', borderRadius: 10, cursor: 'pointer', fontSize: 13, fontWeight: 700 },
  cancelBtn: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 14px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border-default)', borderRadius: 10, cursor: 'pointer', fontSize: 13, fontWeight: 600 },
  filePicker: { display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '12px 13px', background: 'var(--bg-elevated)', color: 'var(--text-secondary)', border: '1px dashed var(--border-strong)', borderRadius: 10, cursor: 'pointer', textAlign: 'left', fontSize: 13 },
  fileList: { display: 'flex', flexDirection: 'column', gap: 4, color: 'var(--text-tertiary)', fontSize: 11, fontWeight: 500 },
  progressText: { display: 'flex', alignItems: 'center', gap: 7, color: 'var(--accent)', fontSize: 12, fontWeight: 600 },
  sectionHeader: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 15 },
  sectionEyebrow: { color: 'var(--accent)', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', marginBottom: 4 },
  sectionTitle: { color: 'var(--text-primary)', fontSize: 22, fontWeight: 700, letterSpacing: '-0.04em' },
  count: { color: 'var(--text-tertiary)', fontSize: 12 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 14 },
  card: { position: 'relative', padding: 18, background: 'rgba(255,255,255,0.86)', borderRadius: 16, cursor: 'pointer', border: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: 17, overflow: 'hidden', minHeight: 190 },
  cardTop: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' },
  cardIconWrap: { position: 'relative', width: 45, height: 45, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  cardIconHalo: { position: 'absolute', inset: -5, borderRadius: 18, border: '1px solid currentColor', opacity: 0.12 },
  cardContent: { flex: 1, minWidth: 0 },
  cardTitle: { fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  cardAuthor: { fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 },
  cardFooter: { display: 'flex', gap: 8, alignItems: 'center', paddingTop: 12, borderTop: '1px solid var(--border-subtle)', marginTop: 'auto' },
  badge: { fontSize: 10, padding: '4px 8px', borderRadius: 20, fontWeight: 700 },
  cardDate: { fontSize: 10, color: 'var(--text-muted)' },
  deleteBtn: { background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 5, borderRadius: 7 },
  emptyState: { textAlign: 'center', padding: '48px 24px', maxWidth: 720, margin: '8px auto 0' },
  emptyIconWrap: { width: 62, height: 62, borderRadius: 20, background: 'var(--accent-subtle)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 17px' },
  emptyTitle: { fontSize: 22, color: 'var(--text-primary)', fontWeight: 700, letterSpacing: '-0.03em' },
  emptyText: { fontSize: 13, color: 'var(--text-secondary)', maxWidth: 510, margin: '9px auto 22px', lineHeight: 1.65 },
  emptyActions: { display: 'flex', justifyContent: 'center', gap: 9, marginBottom: 26 },
  emptySteps: { display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: '10px 20px', color: 'var(--text-tertiary)', fontSize: 11, fontWeight: 600 },
  emptyStep: { display: 'flex', alignItems: 'center', gap: 7 },
  stepDot: { width: 22, height: 22, borderRadius: '50%', background: 'var(--bg-elevated)', color: 'var(--accent)', fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' },
};
