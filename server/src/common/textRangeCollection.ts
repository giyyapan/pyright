/*
* textRangeCollection.ts
* Copyright (c) Microsoft Corporation.
* Licensed under the MIT license.
* Author: Eric Traut
*
* Based on code from vscode-python repository:
*  https://github.com/Microsoft/vscode-python
*
* Class that maintains an ordered list of text ranges and allows
* for indexing and fast lookups within this list.
*/

import { TextRange } from './textRange';

export class TextRangeCollection<T extends TextRange> {
    private _items: T[];

    constructor(items: T[]) {
        this._items = items;
    }

    get start(): number {
        return this._items.length > 0 ? this._items[0].start : 0;
    }

    get end(): number {
        return this._items.length > 0 ? this._items[this._items.length - 1].end : 0;
    }

    get length(): number {
        return this.end - this.start;
    }

    get count(): number {
        return this._items.length;
    }

    contains(position: number) {
        return position >= this.start && position < this.end;
    }

    getItemAt(index: number): T {
        if (index < 0 || index >= this._items.length) {
            throw new Error('index is out of range');
        }
        return this._items[index];
    }

    // Returns the nearest item prior to the position.
    // The position may not be contained within the item.
    getItemAtPosition(position: number): number {
        if (this.count === 0) {
            return -1;
        }
        if (position < this.start) {
            return -1;
        }
        if (position > this.end) {
            return -1;
        }

        let min = 0;
        let max = this.count - 1;

        while (min < max) {
            const mid = Math.floor(min + (max - min) / 2);
            const item = this._items[mid];

            // Is the position past the start of this item but before
            // the start of the next item? If so, we found our item.
            if (position >= item.start) {
                if (mid >= this.count - 1 || position < this._items[mid + 1].start) {
                    return mid;
                }
            }

            if (position < item.start) {
                max = mid - 1;
            } else {
                min = mid + 1;
            }
        }
        return min;
    }

    getItemContaining(position: number): number {
        if (this.count === 0) {
            return -1;
        }
        if (position < this.start) {
            return -1;
        }
        if (position > this.end) {
            return -1;
        }

        let min = 0;
        let max = this.count - 1;

        while (min <= max) {
            const mid = Math.floor(min + (max - min) / 2);
            const item = this._items[mid];

            if (item.contains(position)) {
                return mid;
            }
            if (mid < this.count - 1 && item.end <= position && position < this._items[mid + 1].start) {
                return -1;
            }

            if (position < item.start) {
                max = mid - 1;
            } else {
                min = mid + 1;
            }
        }
        return -1;
    }
}
