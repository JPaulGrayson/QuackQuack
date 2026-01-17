/**
 * Add these to server.ts
 * 
 * 1. Add import at top:
 *    import { initFileStore, uploadFile, getFile, getFileMeta } from './file-store.js';
 * 
 * 2. Add after initStore():
 *    initFileStore();
 * 
 * 3. Add these endpoints before the MCP endpoints section:
 */

// ============== FILE UPLOAD API ==============

// Upload a file (returns fileId for use in messages)
app.post('/api/files', (req, res) => {
  try {
    const { name, content, type, mimeType } = req.body;
    
    if (!name || !content || !type) {
      return res.status(400).json({ 
        error: 'Missing required fields: name, content, type' 
      });
    }
    
    const file = uploadFile(name, content, type, mimeType);
    
    res.json({
      success: true,
      fileId: file.id,
      file: {
        id: file.id,
        name: file.name,
        type: file.type,
        size: file.size,
        expiresAt: file.expiresAt,
      },
    });
  } catch (err) {
    console.error('File upload error:', err);
    res.status(500).json({ error: 'Failed to upload file' });
  }
});

// Get file content
app.get('/api/files/:id', (req, res) => {
  const result = getFile(req.params.id);
  
  if (!result) {
    return res.status(404).json({ error: 'File not found' });
  }
  
  res.json({
    ...result.meta,
    content: result.content,
  });
});

// Get file metadata only (no content)
app.get('/api/files/:id/meta', (req, res) => {
  const meta = getFileMeta(req.params.id);
  
  if (!meta) {
    return res.status(404).json({ error: 'File not found' });
  }
  
  res.json(meta);
});


/**
 * 4. Update the POST /api/send handler to resolve file references:
 * 
 * Add this before creating the message:
 */

// In POST /api/send, add file resolution:
/*
  // Resolve file references if present
  let files = request.files || [];
  
  if (request.fileRefs && request.fileRefs.length > 0) {
    for (const fileId of request.fileRefs) {
      const fileData = getFile(fileId);
      if (fileData) {
        files.push({
          name: fileData.meta.name,
          content: fileData.content,
          type: fileData.meta.type,
          size: fileData.meta.size,
        });
      }
    }
  }
  
  // Then use 'files' in the message creation
*/
