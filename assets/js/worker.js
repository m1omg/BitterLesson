/* worker.js: runs BL.tasks off the main thread. */
importScripts('connect.js', 'digits.js', 'rulebook.js', 'tasks.js');
self.onmessage = (e) => {
  self.BL.tasks.handle(e.data, (m, transfer) => self.postMessage(m, transfer || []));
};
