// Isolated development adapter. Never connects to Urbit or Octra.
export class LocalTlon {
  constructor() { this.posts = {}; this.serial = 10_000; }
  async poke({json}) {
    const p = json.channel.action.post;
    const id = String(++this.serial);
    if (p.add) this.posts[id] = {essay: p.add, seal: {id, replies: {}}};
    else {
      if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{3})*$/.test(p.reply.id)) throw new Error('Fixture requires canonical @ud post ID');
      const parent = this.posts[p.reply.id.replaceAll('.', '')];
      if (!parent) throw new Error('Fixture parent missing');
      parent.seal.replies[id] = {'reply-essay': p.reply.action.add, seal: {id}};
    }
  }
  reply(body, parentId) {
    const id = String(++this.serial);
    const essay = {author: '~zod', content: [{inline: [body]}], sent: Date.now()};
    if (parentId && this.posts[parentId]) this.posts[parentId].seal.replies[id] = {'reply-essay': essay, seal: {id}};
    else this.posts[id] = {essay, seal: {id, replies: {}}};
  }
  history() { return {posts: this.posts}; }
}
