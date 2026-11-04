import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Ticket } from '../../database/entities/ticket.entity';
import { TicketsService } from './tickets.service';
import { TicketsController } from './tickets.controller';
import { MessagesModule } from '../messages/messages.module';

@Module({
  imports: [TypeOrmModule.forFeature([Ticket]), MessagesModule],
  controllers: [TicketsController],
  providers: [TicketsService],
  exports: [TicketsService],
})
export class TicketsModule {}
