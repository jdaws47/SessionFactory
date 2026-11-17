/**
 * Physical order of crates on a queue belt (front first) after some leave and others arrive.
 * The belt only exits past the front, so every crate still in the queue that sits in front of the
 * last one leaving has to ride out ahead of it, loop round, and rejoin at the back.
 */
export function reorderQueue(queue: string[], staying: Set<string>, arrivals: string[]): { queue: string[]; loopers: string[] } {
  let lastLeaving = -1;
  queue.forEach((id, i) => {
    if (!staying.has(id)) lastLeaving = i;
  });
  const ahead = queue.filter((id, i) => i < lastLeaving && staying.has(id));
  const behind = queue.filter((id, i) => i > lastLeaving && staying.has(id));
  const known = new Set(queue);
  return { queue: [...behind, ...ahead, ...arrivals.filter((id) => !known.has(id))], loopers: ahead };
}
