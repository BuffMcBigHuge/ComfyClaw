// comfy.js
// A simple web wrapper around the ComfyUI API.

const WebSocket = require('ws');
const crypto = require('node:crypto');
const url = require('node:url');
const fs = require('node:fs');
const path = require('node:path');

class ComfyUI {
  constructor({
    comfyUIServerURL,
    nodes,
    onSaveCallback,
    onMessageCallback,
    onOpenCallback,
    onErrorCallback, // New: for error handling
  }) {
    // Init
    this.comfyUI = null;
    this.clientId = crypto.randomUUID();
    this.nodes = nodes;
    this.queueRemaining = 0;
    this.imageURL = null;
    this.comfyUIServerURL = comfyUIServerURL;
    this.promptId = -1;

    // Connection state management
    this.isConnected = false;
    this.isConnecting = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 3;
    this.reconnectDelay = 1000; // Start with 1 second
    this.maxReconnectDelay = 30000; // Max 30 seconds
    this.connectionTimeout = 30000; // 30 second timeout
    this.reconnectTimer = null;
    this.connectionTimer = null;
    this.hasProcessedWorkflow = false;

    if (onSaveCallback) {
      this.onSaveCallback = onSaveCallback;
    }

    if (onMessageCallback) {
      this.onMessageCallback = onMessageCallback;
    }

    if (onOpenCallback) {
      this.onOpenCallback = onOpenCallback;
    }

    if (onErrorCallback) {
      this.onErrorCallback = onErrorCallback;
    }

    // Connect
    this.connect();
  }

  connect() {
    if (this.isConnecting || this.isConnected) {
      return;
    }

    this.isConnecting = true;

    console.log(`Connecting to ComfyUI server ${this.comfyUIServerURL}... (Attempt ${this.reconnectAttempts + 1})`);

    // Clear any existing timers
    this.clearTimers();

    // Set connection timeout
    this.connectionTimer = setTimeout(() => {
      if (!this.isConnected) {
        console.error('Connection timeout to ComfyUI server');
        this.handleConnectionFailure('Connection timeout');
      }
    }, this.connectionTimeout);

    const socketURL = `${this.comfyUIServerURL.replace('https://', 'wss://').replace('http://', 'ws://')}/ws?clientId=${this.clientId}`;

    try {
      this.comfyUI = new WebSocket(socketURL);

      // Connect
      this.comfyUI.onopen = (data) => {
        console.log('ComfyUI server opened.');
        this.isConnected = true;
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000; // Reset delay

        // Clear connection timeout
        if (this.connectionTimer) {
          clearTimeout(this.connectionTimer);
          this.connectionTimer = null;
        }

        // Only call onOpenCallback on first successful connection
        if (this.onOpenCallback && !this.hasProcessedWorkflow) {
          this.onOpenCallback(this);
        }
      };

      // Disconnect
      this.comfyUI.onclose = (event) => {
        console.log(`ComfyUI server closed: Code=${event.code}, Reason=${event.reason || 'Unknown'}`);
        this.isConnected = false;
        this.isConnecting = false;

        // Clear timers
        this.clearTimers();

        // If we haven't processed workflow yet and connection was lost, handle as failure
        if (!this.hasProcessedWorkflow) {
          this.handleConnectionFailure(`Connection closed: ${event.reason || 'Unknown reason'}`);
        } else {
          // Just log if workflow was already processed
          console.log('Connection closed after workflow completion');
        }
      };

      // Message
      this.comfyUI.onmessage = async (event) => {
        // Send Image Websocket Method      
        if (event.data instanceof Buffer) { // Changed from Blob check        
          // Handle binary data directly using Buffer
          /*
          const arrayBuffer = event.data;
          const dataView = new DataView(arrayBuffer.buffer);
          const event = dataView.getUint32(0);
          const format = dataView.getUint32(4);

          if (event === 1) {
            let imageData = arrayBuffer.slice(8);  // Extract image data
            let mimeType = format === 1 ? 'image/jpeg' : 'image/png';

            if (this.onSaveCallback) {
              this.onSaveCallback({ 
                buffer: imageData, 
                mimeType, 
                promptId: this.promptId 
              });
            }
          }
          */
        } else {
          try {
            const message = JSON.parse(event.data);

            if (!['crystools.monitor', 'progress'].includes(message.type)) {
              // console.log('Web Socket:', message);
            }

            if (message.type === 'status') {
              this.queueRemaining = message.data.status.exec_info.queue_remaining;
              // End of queue
              if (this.queueRemaining === 0) {
                // Not sure if this is needed
              }
            }

            if (message.data?.prompt_id && message.data.prompt_id === this.promptId) {
              // Queue Callback

              // Execution Started
              if (message.type === 'execution_start') {
                console.log('Execution Started', message);
                this.hasProcessedWorkflow = true;
              }

              // Execution Error
              if (message.type === 'execution_error') {
                console.error('Execution Error', message);
              }

              // Executed
              if (message.type === 'executed') {
                console.log('Executed:', message);

                // Save Callback
                if (this.nodes.api_save.includes(message.data.node)) {
                  console.log(`Saving File: ${message.data.prompt_id}`);

                  // Method: Triggers when node matches "api_save" in the nodes object, 
                  // usually a PreviewImage, or VHS_VideoCombine
                  if (this.onSaveCallback) {
                    this.onSaveCallback({ message, promptId: this.promptId });
                  }
                }
              }

              // Executed Complete
              if (message.type === 'execution_success') {
                console.log('Executed Complete:', message);
              }

              if (message.type === 'status' && message.data?.status?.exec_info?.queue_remaining === 0) {
                // Empty Queue
                console.log('Empty Queue');
              }

              // Message Callback
              if ([
                'executed',
                'execution_start',
                'execution_cache',
                'execution_error',
                'execution_success',
              ].includes(message.type)) {
                if (this.onMessageCallback) {
                  this.onMessageCallback({ message, promptId: this.promptId });
                }
              }
            }
          } catch (err) {
            console.error('Unknown message:', event.data);
            console.error(err);
          }
        }
      };
    } catch (err) {
      console.error('Error creating WebSocket:', err);
      this.handleConnectionFailure(err.message);
    }

    // Error
    this.comfyUI.onerror = (err) => {
      console.error('WebSocket Error:', err);
      console.error(`Websocket Error with Client ${this.clientId}`);
      this.handleConnectionFailure(`WebSocket error: ${err.message || 'Unknown error'}`);
    };
  }

  handleConnectionFailure(reason) {
    console.error(`Connection failure: ${reason}`);

    this.isConnected = false;
    this.isConnecting = false;

    // Clear timers
    this.clearTimers();

    // If we already processed workflow, don't attempt reconnection
    if (this.hasProcessedWorkflow) {
      console.log('Workflow already processed, not attempting reconnection');
      return;
    }

    // Attempt reconnection if we haven't exceeded max attempts
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay); // Exponential backoff

      console.log(`Attempting to reconnect in ${this.reconnectDelay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

      this.reconnectTimer = setTimeout(() => {
        this.connect();
      }, this.reconnectDelay);
    } else {
      // Exceeded max reconnection attempts
      console.error(`Max reconnection attempts (${this.maxReconnectAttempts}) reached`);

      if (this.onErrorCallback) {
        this.onErrorCallback(new Error(`Failed to connect to ComfyUI server after ${this.maxReconnectAttempts} attempts: ${reason}`));
      }
    }
  }

  clearTimers() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }
  }

  disconnect() {
    console.log('Disconnecting from ComfyUI server.');

    // Clear timers
    this.clearTimers();

    this.isConnected = false;
    this.isConnecting = false;

    if (this.comfyUI) {
      this.comfyUI.close();
      this.comfyUI = null;
    }
  }

  queue({ workflowDataAPI }) {
    return new Promise(async (resolve, reject) => {
      try {
        const options = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            prompt: workflowDataAPI,
            client_id: this.clientId,
          }),
        };

        const response = await fetch(`${this.comfyUIServerURL}/prompt`, options);

        // Parse the response body (ComfyUI returns JSON with error details even on 400)
        let responseData;
        try {
          responseData = await response.json();
        } catch {
          if (!response.ok) {
            throw new Error(`Server responded with status ${response.status} (no JSON body)`);
          }
          throw new Error('Server returned non-JSON response');
        }

        // Surface validation errors from non-OK responses
        if (!response.ok) {
          const lines = [`ComfyUI server error (HTTP ${response.status}):`];

          // Top-level error info
          if (responseData.error) {
            const err = responseData.error;
            lines.push(`  ${err.type || 'error'}: ${err.message || JSON.stringify(err)}`);
          }

          // Node-specific validation errors
          if (responseData.node_errors && Object.keys(responseData.node_errors).length > 0) {
            for (const [nodeId, nodeError] of Object.entries(responseData.node_errors)) {
              const tag = nodeError._meta?.title || '';
              lines.push(`  Node ${nodeId}${tag ? ' (' + tag + ')' : ''} [${nodeError.class_type}]:`);
              if (Array.isArray(nodeError.errors)) {
                for (const error of nodeError.errors) {
                  lines.push(`    - ${error.message || JSON.stringify(error)}`);
                  if (error.details) lines.push(`      ${error.details}`);
                }
              }
            }
          }

          // Extra info (ComfyUI sometimes puts details here)
          if (responseData.extra_info) {
            lines.push(`  Details: ${JSON.stringify(responseData.extra_info)}`);
          }

          throw new Error(lines.join('\n'));
        }

        // Set Prompt ID
        if (responseData.prompt_id) {
          this.promptId = responseData.prompt_id;
        }

        // Print and check node errors on successful queue (warnings)
        if (responseData.node_errors && Object.keys(responseData.node_errors).length > 0) {
          for (const [nodeId, nodeError] of Object.entries(responseData.node_errors)) {
            console.error(`Node ${nodeId} (${nodeError.class_type}):`);
            if (Array.isArray(nodeError.errors)) {
              nodeError.errors.forEach((error, index) => {
                console.error(`  Error ${index + 1}: ${error.message || JSON.stringify(error)}`);
              });
            }
            if (nodeError.dependent_outputs?.length > 0) {
              console.error('  Affected outputs:', nodeError.dependent_outputs);
            }
          }
        }

        // Check if any dependent_outputs include the nodes.api_save string value
        const saveNodeAffected = Object.values(responseData.node_errors || {}).some((nodeError) =>
          nodeError.dependent_outputs?.some((output) => this.nodes.api_save.includes(output))
        );

        if (saveNodeAffected) {
          // Cancel the request
          console.error('Save node affected by errors.');
          this.interupt();
          reject(new Error('Save node affected by errors.'));
        } else {
          console.log(responseData);
          resolve(responseData);
        }
      } catch (err) {
        console.error(err);
        reject(err);
      }
    });
  }

  interupt() {
    return new Promise(async (resolve, reject) => {
      try {
        // TODO: Does this ONLY remove the prompt from the queue?
        //       What if the prompt is already running?

        const response = await fetch(`${this.comfyUIServerURL}/api/interrupt`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            client_id: this.clientId,
            prompt_id: this.promptId,
          }),
        });

        if (!response.ok) {
          throw new Error(`Server responded with status ${response.status}`);
        }
        resolve();
      } catch (err) {
        console.error(err);
        reject(err);
      }
    });
  }

  getFile({ filename, subfolder, type }) {
    return new Promise(async (resolve, reject) => {
      try {
        const data = {
          filename,
          subfolder,
          type,
        };

        const urlString = `${this.comfyUIServerURL}/view?${new url.URLSearchParams(data)}`;

        console.log(`Retrieving File ${urlString}.`);

        const response = await fetch(urlString);
        if (!response.ok) {
          throw new Error(`Failed to fetch file: ${response.status} ${response.statusText}`);
        }
        const ab = await response.arrayBuffer();
        resolve(Buffer.from(ab));

      } catch (err) {
        console.error(err);
        reject(err);
      }
    });
  }

  /**
   * Upload a local file to the ComfyUI server.
   * Uses the /upload/image endpoint (handles both images and audio).
   *
   * @param {string} filePath - Absolute or relative path to the local file
   * @param {object} [opts]
   * @param {string} [opts.subfolder] - Optional subfolder on the server
   * @param {boolean} [opts.overwrite] - Overwrite if file exists (default: true)
   * @returns {Promise<{name: string, subfolder: string, type: string}>}
   */
  async uploadFile(filePath, { subfolder, overwrite = true } = {}) {
    const resolvedPath = path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File not found: ${resolvedPath}`);
    }

    const fileBuffer = fs.readFileSync(resolvedPath);
    const filename = path.basename(resolvedPath);

    // Determine MIME type from extension
    const ext = path.extname(filename).slice(1).toLowerCase();
    const mimeTypes = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
      bmp: 'image/bmp',
      tiff: 'image/tiff',
      wav: 'audio/wav',
      mp3: 'audio/mpeg',
      flac: 'audio/flac',
      ogg: 'audio/ogg',
      m4a: 'audio/mp4',
    };
    const mimeType = mimeTypes[ext] || 'application/octet-stream';

    // Build multipart form data
    const blob = new Blob([fileBuffer], { type: mimeType });
    const formData = new FormData();
    formData.append('image', blob, filename);
    formData.append('overwrite', overwrite ? 'true' : 'false');
    if (subfolder) {
      formData.append('subfolder', subfolder);
    }

    console.log(`Uploading ${filename} (${fileBuffer.length} bytes) to ${this.comfyUIServerURL}/upload/image ...`);

    const response = await fetch(`${this.comfyUIServerURL}/upload/image`, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Upload failed (HTTP ${response.status}): ${text}`);
    }

    const result = await response.json();
    console.log(`Upload complete: ${result.name} (subfolder: ${result.subfolder || ''}, type: ${result.type || 'input'})`);
    return result;
  }
}

module.exports = ComfyUI;

// EOF
