// helpers.js - Helper functions for ComfyUI

// Load config
const config = require('./config.js');

// Sentry is optional; use a no-op if not provided
const Sentry = global.Sentry || {
  captureException: () => {},
};

// Helper function to get server with lowest queue
const getServerWithLowestQueue = async () => {
  const servers = config.servers;
  let serverToUse = null;
  
  try {
    // Check queue size for each server with timeout
    const queueSizes = await Promise.all(
      servers.map(async (serverUrl) => {
        try {
          // Add timeout to server health check
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
          
          const response = await fetch(`${serverUrl}/api/queue`, {
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
            },
          });
          
          clearTimeout(timeoutId);
          
          if (!response.ok) {
            throw new Error(`Server ${serverUrl} responded with status ${response.status}`);
          }
          
          const queueData = await response.json();
          
          // Calculate total queue size (running + pending)
          const queueRunningCount = Array.isArray(queueData.queue_running) 
            ? queueData.queue_running.length 
            : (queueData.queue_running ? 1 : 0);
          
          const queuePendingCount = Array.isArray(queueData.queue_pending)
            ? queueData.queue_pending.length
            : (typeof queueData.queue_pending === 'number' ? queueData.queue_pending : 0);
            
          const totalQueueSize = queueRunningCount + queuePendingCount;
          
          console.log(`Server ${serverUrl} queue check: running=${queueRunningCount}, pending=${queuePendingCount}, total=${totalQueueSize}`);
          
          return {
            serverUrl,
            totalQueueSize,
            isAvailable: true,
          };
        } catch (err) {
          const errorMessage = err.name === 'AbortError' ? 'Timeout' : err.message;
          console.error(`Error checking queue for server ${serverUrl}: ${errorMessage}`);
          
          // Note: Sentry integration removed for this lightweight wrapper.
          return {
            serverUrl,
            totalQueueSize: Infinity,
            isAvailable: false,
            error: errorMessage,
          };
        }
      }),
    );
    
    // Find server with smallest queue
    const availableServers = queueSizes.filter((s) => s.isAvailable);
    if (availableServers.length > 0) {
      // Sort by queue size (ascending)
      availableServers.sort((a, b) => a.totalQueueSize - b.totalQueueSize);
      serverToUse = availableServers[0].serverUrl;
      console.log(`Selected server ${serverToUse} with queue size ${availableServers[0].totalQueueSize}`);
      return { serverToUse, allServersDown: false };
    }

    // No servers available - log details about each server's status
    console.log('All servers unavailable, cannot process request');
    queueSizes.forEach((server) => {
      if (!server.isAvailable) {
        console.log(`- ${server.serverUrl}: ${server.error || 'Unknown error'}`);
      }
    });
    
    return { serverToUse: null, allServersDown: true };
  } catch (err) {
    console.error('Error during server selection:', err);
    // Error in server selection logic
    return { serverToUse: null, allServersDown: true };
  }
};

module.exports = {
  getServerWithLowestQueue,
};