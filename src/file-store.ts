/**
 * Quack File Store
 * Handles file uploads with 24-hour expiration
 */

import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';

const FILES_DIR = './data/files';
const FILE_TTL_HOURS = 24;

interface StoredFile {
  id: string;
  name: string;
  type: 'code' | 'doc' | 'image' | 'data';
  mimeType?: string;
  size: number;
  createdAt: string;
  expiresAt: string;
  path: string;
}

const fileIndex: Map<string, StoredFile> = new Map();

export function initFileStore(): void {
  if (!fs.existsSync(FILES_DIR)) {
    fs.mkdirSync(FILES_DIR, { recursive: true });
  }
  
  // Load existing file index
  const indexPath = path.join(FILES_DIR, 'index.json');
  if (fs.existsSync(indexPath)) {
    const data = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    for (const file of data) {
      fileIndex.set(file.id, file);
    }
  }
  
  // Cleanup expired files every hour
  setInterval(cleanupExpiredFiles, 60 * 60 * 1000);
  cleanupExpiredFiles();
}

function persistIndex(): void {
  const indexPath = path.join(FILES_DIR, 'index.json');
  fs.writeFileSync(indexPath, JSON.stringify(Array.from(fileIndex.values()), null, 2));
}

function cleanupExpiredFiles(): void {
  const now = new Date();
  let cleaned = 0;
  
  for (const [id, file] of fileIndex) {
    if (new Date(file.expiresAt) < now) {
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
      fileIndex.delete(id);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    console.log(`🧹 Cleaned ${cleaned} expired files`);
    persistIndex();
  }
}

export function uploadFile(
  name: string, 
  content: string, 
  type: 'code' | 'doc' | 'image' | 'data', 
  mimeType?: string
): StoredFile {
  const id = `file_${uuid().split('-')[0]}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + FILE_TTL_HOURS * 60 * 60 * 1000);
  const filePath = path.join(FILES_DIR, id);
  
  fs.writeFileSync(filePath, content);
  
  const file: StoredFile = {
    id,
    name,
    type,
    mimeType,
    size: Buffer.byteLength(content, 'utf-8'),
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    path: filePath,
  };
  
  fileIndex.set(id, file);
  persistIndex();
  
  console.log(`📁 File uploaded: ${id} (${name}, ${file.size} bytes)`);
  return file;
}

export function getFile(id: string): { meta: StoredFile; content: string } | null {
  const meta = fileIndex.get(id);
  if (!meta || !fs.existsSync(meta.path)) {
    return null;
  }
  
  const content = fs.readFileSync(meta.path, 'utf-8');
  return { meta, content };
}

export function getFileMeta(id: string): StoredFile | null {
  return fileIndex.get(id) || null;
}

export function deleteFile(id: string): boolean {
  const file = fileIndex.get(id);
  if (!file) return false;
  
  if (fs.existsSync(file.path)) {
    fs.unlinkSync(file.path);
  }
  fileIndex.delete(id);
  persistIndex();
  return true;
}
