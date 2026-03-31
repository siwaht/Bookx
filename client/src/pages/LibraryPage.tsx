import React, { useEffect, useState, useRef } from 'react';
import { library } from '../services/api';
import type { LibraryBook } from '../types';
import {
  Upload, BookOpen, Trash2, Download, FileT            {detailTab === 'read' && (
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
                <p style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Read your book in the browser.</p>
                {selectedBook.original_format === 'pdf' ? (
                  <>
                    <a href={library.readUrl(selectedBook.id)} target="_blank" rel="noopener noreferrer" style={st.readBtn}><Eye size={16} /> Open PDF Reader</a>
                    <iframe src={library.readUrl(selectedBook.id)} style={{ width: '100%', height: 500, border: '1px solid var(--border-subtle)', borderRadius: 8, background: '#fff' }} title="Reader" />
                  </>
                ) : selectedBook.original_format === 'epub' ? (
                  <a href={library.readUrl(selectedBook.id)} target="_blank" rel="noopener noreferrer" style={st.readBtn}><Eye size={16} /> Download EPUB to read</a>
                ) : (selectedBook.original_format === 'docx' || selectedBook.original_format === 'txt') ? (
                  <>
                    <a href={library.readHtmlUrl(selectedBook.id)} target="_blank" rel="noopener noreferrer" style={st.readBtn}><Eye size={16} /> Open {fl(selectedBook.original_format)} Reader</a>
                    <iframe src={library.readHtmlUrl(selectedBook.id)} style={{ width: '100%', height: 500, border: '1px solid var(--border-subtle)', borderRadius: 8, background: '#fff' }} title="Reader" />
                  </>
                ) : (
                  <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>This format cannot be read in browser. Download or upload a PDF/EPUB.</div>
                )}
                {selectedBook.formats?.filter(f => f.format !== selectedBook.original_format && canRead(f.format)).map(fmt => (
                  <a key={fmt.id} href={fmt.format === 'docx' || fmt.format === 'txt' ? library.readHtmlUrl(selectedBook.id) : library.formatReadUrl(selectedBook.id, fmt.id)} target="_blank" rel="noopener noreferrer" style={st.readBtn}><Eye size={16} /> Read {fl(fmt.format)}</a>
                ))}
                <a href={library.downloadUrl(selectedBook.id)} style={{ ...st.readBtn, background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}><Download size={16} /> Download original</a>
              </div>
            )}