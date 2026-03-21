import { Component, inject, OnInit } from '@angular/core';
import { DataManagerService } from '../../services/data-manager.service';

@Component({
    selector:    'app-data-manager',
    imports:     [],
    templateUrl: './data-manager.html',
    styleUrl:    './data-manager.scss',
})
export class DataManagerComponent implements OnInit {
    protected readonly dataManagerService = inject(DataManagerService);

    ngOnInit(): void {
        this.dataManagerService.refresh();
    }

    async onRevert(): Promise<void> {
        await this.dataManagerService.revertToOriginal();
    }

    async onClear(): Promise<void> {
        await this.dataManagerService.clearDocument();
    }
}