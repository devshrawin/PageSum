// Pure Server-Sent Events parser. Feed decoded strings; get data payloads.

export function createSseParser(onData) {
  let buffer = '';
  const SEP = /\r?\n\r?\n/;

  function dispatch(eventText) {
    const data = [];
    for (const line of eventText.split(/\r?\n/)) {
      if (line.startsWith('data:')) {
        let v = line.slice(5);
        if (v.startsWith(' ')) v = v.slice(1);
        data.push(v);
      }
      // comments (':'), event:, id:, retry: are ignored
    }
    if (data.length) onData(data.join('\n'));
  }

  return {
    push(chunk) {
      buffer += chunk;
      let m;
      while ((m = SEP.exec(buffer))) {
        const ev = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        dispatch(ev);
      }
    },
    end() {
      const rest = buffer;
      buffer = '';
      if (rest.trim() !== '') dispatch(rest);
    },
  };
}
