type Role = 'user' | 'bot';

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export class Transcript {
    private root: HTMLElement;
    private list: HTMLElement;
    private empty: HTMLElement | null;
    private typing: HTMLElement | null = null;
    private openBotBubble: HTMLElement | null = null;

    constructor(root: HTMLElement) {
        this.root = root;
        this.list = root.querySelector('.transcript-list') as HTMLElement;
        this.empty = root.querySelector('.transcript-empty');
    }

    clear(): void {
        this.list.innerHTML = '';
        this.openBotBubble = null;
        this.typing = null;
        this.empty?.classList.remove('hidden');
    }

    addUser(text: string): void {
        const clean = text.trim();
        if (!clean) return;
        this.openBotBubble = null;
        this.append('user', clean);
    }

    /** Bot text arrives one sentence at a time; keep appending to the same bubble until the turn ends. */
    appendBot(text: string): void {
        const clean = text.trim();
        if (!clean) return;
        this.setTyping(false);
        if (this.openBotBubble) {
            const body = this.openBotBubble.querySelector('.bubble-text') as HTMLElement;
            body.textContent = `${body.textContent} ${clean}`;
            this.scrollToEnd();
            return;
        }
        this.openBotBubble = this.append('bot', clean);
    }

    endBotTurn(): void {
        this.openBotBubble = null;
    }

    setTyping(show: boolean): void {
        if (show && !this.typing) {
            this.typing = this.buildRow('bot');
            this.typing.classList.add('typing');
            const bubble = this.typing.querySelector('.bubble') as HTMLElement;
            bubble.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
            this.list.appendChild(this.typing);
            this.scrollToEnd();
        } else if (!show && this.typing) {
            this.typing.remove();
            this.typing = null;
        }
    }

    private append(role: Role, text: string): HTMLElement {
        this.empty?.classList.add('hidden');
        const row = this.buildRow(role);
        const bubble = row.querySelector('.bubble') as HTMLElement;

        const body = document.createElement('div');
        body.className = 'bubble-text';
        body.textContent = text;

        const time = document.createElement('time');
        time.className = 'bubble-time';
        time.textContent = timeFormat.format(new Date());

        bubble.append(body, time);

        // Keep the typing indicator at the bottom of the thread.
        if (this.typing) {
            this.list.insertBefore(row, this.typing);
        } else {
            this.list.appendChild(row);
        }
        this.scrollToEnd();
        return row;
    }

    private buildRow(role: Role): HTMLElement {
        const row = document.createElement('div');
        row.className = `message ${role}`;

        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        avatar.textContent = role === 'bot' ? 'T' : 'You';

        const bubble = document.createElement('div');
        bubble.className = 'bubble';

        row.append(avatar, bubble);
        return row;
    }

    private scrollToEnd(): void {
        const el = this.root;
        const pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        if (pinned) {
            el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        }
    }
}
