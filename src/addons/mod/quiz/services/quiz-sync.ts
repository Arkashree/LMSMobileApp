// (C) Copyright 2015 Moodle Pty Ltd.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { Injectable } from '@angular/core';

import { CoreError } from '@classes/errors/error';
import { CoreCourseActivitySyncBaseProvider } from '@features/course/classes/activity-sync';
import { CoreCourse, CoreCourseModuleBasicInfo } from '@features/course/services/course';
import { CoreCourseLogHelper } from '@features/course/services/log-helper';
import { CoreCourseModulePrefetchDelegate } from '@features/course/services/module-prefetch-delegate';
import { CoreQuestion, CoreQuestionQuestionParsed } from '@features/question/services/question';
import { CoreQuestionDelegate } from '@features/question/services/question-delegate';
import { CoreNetwork } from '@services/network';
import { CoreSites, CoreSitesReadingStrategy } from '@services/sites';
import { CoreSync, CoreSyncResult } from '@services/sync';
import { CoreUtils } from '@services/utils/utils';
import { makeSingleton, Translate } from '@singletons';
import { CoreEvents } from '@singletons/events';
import { AddonModQuizAttemptDBRecord } from './database/quiz';
import { AddonModQuizPrefetchHandler } from './handlers/prefetch';
import { AddonModQuiz, AddonModQuizAttemptWSData, AddonModQuizProvider, AddonModQuizQuizWSData } from './quiz';
import { AddonModQuizOffline, AddonModQuizQuestionsWithAnswers } from './quiz-offline';

/**
 * Service to sync quizzes.
 */
@Injectable({ providedIn: 'root' })
export class AddonModQuizSyncProvider extends CoreCourseActivitySyncBaseProvider<AddonModQuizSyncResult> {

    static readonly AUTO_SYNCED = 'addon_mod_quiz_autom_synced';

    protected componentTranslatableString = 'quiz';

    constructor() {
        super('AddonModQuizSyncProvider');
    }

    /**
     * Finish a sync process: remove offline data if needed, prefetch quiz data, set sync time and return the result.
     *
     * @param siteId Site ID.
     * @param quiz Quiz.
     * @param courseId Course ID.
     * @param warnings List of warnings generated by the sync.
     * @param options Other options.
     * @returns Promise resolved on success.
     */
    protected async finishSync(
        siteId: string,
        quiz: AddonModQuizQuizWSData,
        courseId: number,
        warnings: string[],
        options?: FinishSyncOptions,
    ): Promise<AddonModQuizSyncResult> {
        options = options || {};

        // Invalidate the data for the quiz and attempt.
        await CoreUtils.ignoreErrors(
            AddonModQuiz.invalidateAllQuizData(quiz.id, courseId, options.attemptId, siteId),
        );

        if (options.removeAttempt && options.attemptId) {
            const promises: Promise<unknown>[] = [];

            promises.push(AddonModQuizOffline.removeAttemptAndAnswers(options.attemptId, siteId));

            if (options.onlineQuestions) {
                for (const slot in options.onlineQuestions) {
                    promises.push(CoreQuestionDelegate.deleteOfflineData(
                        options.onlineQuestions[slot],
                        AddonModQuizProvider.COMPONENT,
                        quiz.coursemodule,
                        siteId,
                    ));
                }
            }

            await Promise.all(promises);
        }

        if (options.updated) {
            try {
                // Data has been sent. Update prefetched data.
                const module = await CoreCourse.getModuleBasicInfoByInstance(quiz.id, 'quiz', { siteId });

                await this.prefetchAfterUpdateQuiz(module, quiz, courseId, siteId);
            } catch {
                // Ignore errors.
            }
        }

        await CoreUtils.ignoreErrors(this.setSyncTime(quiz.id, siteId));

        // Check if online attempt was finished because of the sync.
        let attemptFinished = false;
        if (options.onlineAttempt && !AddonModQuiz.isAttemptFinished(options.onlineAttempt.state)) {
            // Attempt wasn't finished at start. Check if it's finished now.
            const attempts = await AddonModQuiz.getUserAttempts(quiz.id, { cmId: quiz.coursemodule, siteId });

            const attempt = attempts.find(({ id }) => id == options?.onlineAttempt?.id);

            attemptFinished = attempt ? AddonModQuiz.isAttemptFinished(attempt.state) : false;
        }

        return { warnings, attemptFinished, updated: !!options.updated || !!options.removeAttempt };
    }

    /**
     * Check if a quiz has data to synchronize.
     *
     * @param quizId Quiz ID.
     * @param siteId Site ID. If not defined, current site.
     * @returns Promise resolved with boolean: whether it has data to sync.
     */
    async hasDataToSync(quizId: number, siteId?: string): Promise<boolean> {
        try {
            const attempts = await AddonModQuizOffline.getQuizAttempts(quizId, siteId);

            return !!attempts.length;
        } catch {
            return false;
        }
    }

    /**
     * Conveniece function to prefetch data after an update.
     *
     * @param module Module.
     * @param quiz Quiz.
     * @param courseId Course ID.
     * @param siteId Site ID. If not defined, current site.
     * @returns Promise resolved when done.
     */
    protected async prefetchAfterUpdateQuiz(
        module: CoreCourseModuleBasicInfo,
        quiz: AddonModQuizQuizWSData,
        courseId: number,
        siteId?: string,
    ): Promise<void> {
        let shouldDownload = false;

        // Get the module updates to check if the data was updated or not.
        const result = await CoreCourseModulePrefetchDelegate.getModuleUpdates(module, courseId, true, siteId);

        if (result?.updates?.length) {
            const regex = /^.*files$/;

            // Only prefetch if files haven't changed.
            shouldDownload = !result.updates.find((entry) => entry.name.match(regex));

            if (shouldDownload) {
                await AddonModQuizPrefetchHandler.download(module, courseId, undefined, false, false);
            }
        }

        // Prefetch finished or not needed, set the right status.
        await AddonModQuizPrefetchHandler.setStatusAfterPrefetch(quiz, {
            cmId: module.id,
            readingStrategy: shouldDownload ? CoreSitesReadingStrategy.PREFER_CACHE : undefined,
            siteId,
        });
    }

    /**
     * Try to synchronize all the quizzes in a certain site or in all sites.
     *
     * @param siteId Site ID to sync. If not defined, sync all sites.
     * @param force Wether to force sync not depending on last execution.
     * @returns Promise resolved if sync is successful, rejected if sync fails.
     */
    syncAllQuizzes(siteId?: string, force?: boolean): Promise<void> {
        return this.syncOnSites('all quizzes', (id) => this.syncAllQuizzesFunc(!!force, id), siteId);
    }

    /**
     * Sync all quizzes on a site.
     *
     * @param force Wether to force sync not depending on last execution.
     * @param siteId Site ID to sync.
     * @returns Promise resolved if sync is successful, rejected if sync fails.
     */
    protected async syncAllQuizzesFunc(force: boolean, siteId: string): Promise<void> {
        // Get all offline attempts.
        const attempts = await AddonModQuizOffline.getAllAttempts(siteId);

        const quizIds: Record<number, boolean> = {}; // To prevent duplicates.

        // Sync all quizzes that haven't been synced for a while and that aren't attempted right now.
        await Promise.all(attempts.map(async (attempt) => {
            if (quizIds[attempt.quizid]) {
                // Quiz already treated.
                return;
            }
            quizIds[attempt.quizid] = true;

            if (CoreSync.isBlocked(AddonModQuizProvider.COMPONENT, attempt.quizid, siteId)) {
                return;
            }

            // Quiz not blocked, try to synchronize it.
            const quiz = await AddonModQuiz.getQuizById(attempt.courseid, attempt.quizid, { siteId });

            const data = await (force ? this.syncQuiz(quiz, false, siteId) : this.syncQuizIfNeeded(quiz, false, siteId));

            if (data?.warnings?.length) {
                // Store the warnings to show them when the user opens the quiz.
                await this.setSyncWarnings(quiz.id, data.warnings, siteId);
            }

            if (data) {
                // Sync successful. Send event.
                CoreEvents.trigger(AddonModQuizSyncProvider.AUTO_SYNCED, {
                    quizId: quiz.id,
                    attemptFinished: data.attemptFinished,
                    warnings: data.warnings,
                }, siteId);
            }
        }));
    }

    /**
     * Sync a quiz only if a certain time has passed since the last time.
     *
     * @param quiz Quiz.
     * @param askPreflight Whether we should ask for preflight data if needed.
     * @param siteId Site ID. If not defined, current site.
     * @returns Promise resolved when the quiz is synced or if it doesn't need to be synced.
     */
    async syncQuizIfNeeded(
        quiz: AddonModQuizQuizWSData,
        askPreflight?: boolean,
        siteId?: string,
    ): Promise<AddonModQuizSyncResult | undefined> {
        const needed = await this.isSyncNeeded(quiz.id, siteId);

        if (needed) {
            return this.syncQuiz(quiz, askPreflight, siteId);
        }
    }

    /**
     * Try to synchronize a quiz.
     * The promise returned will be resolved with an array with warnings if the synchronization is successful.
     *
     * @param quiz Quiz.
     * @param askPreflight Whether we should ask for preflight data if needed.
     * @param siteId Site ID. If not defined, current site.
     * @returns Promise resolved in success.
     */
    syncQuiz(quiz: AddonModQuizQuizWSData, askPreflight?: boolean, siteId?: string): Promise<AddonModQuizSyncResult> {
        siteId = siteId || CoreSites.getCurrentSiteId();

        const currentSyncPromise = this.getOngoingSync(quiz.id, siteId);
        if (currentSyncPromise) {
            // There's already a sync ongoing for this quiz, return the promise.
            return currentSyncPromise;
        }

        // Verify that quiz isn't blocked.
        if (CoreSync.isBlocked(AddonModQuizProvider.COMPONENT, quiz.id, siteId)) {
            this.logger.debug('Cannot sync quiz ' + quiz.id + ' because it is blocked.');

            throw new CoreError(Translate.instant('core.errorsyncblocked', { $a: this.componentTranslate }));
        }

        return this.addOngoingSync(quiz.id, this.performSyncQuiz(quiz, askPreflight, siteId), siteId);
    }

    /**
     * Perform the quiz sync.
     *
     * @param quiz Quiz.
     * @param askPreflight Whether we should ask for preflight data if needed.
     * @param siteId Site ID. If not defined, current site.
     * @returns Promise resolved in success.
     */
    async performSyncQuiz(quiz: AddonModQuizQuizWSData, askPreflight?: boolean, siteId?: string): Promise<AddonModQuizSyncResult> {
        siteId = siteId || CoreSites.getCurrentSiteId();

        const warnings: string[] = [];
        const courseId = quiz.course;
        const modOptions = {
            cmId: quiz.coursemodule,
            readingStrategy: CoreSitesReadingStrategy.ONLY_NETWORK,
            siteId,
        };

        this.logger.debug('Try to sync quiz ' + quiz.id + ' in site ' + siteId);

        // Sync offline logs.
        await CoreUtils.ignoreErrors(
            CoreCourseLogHelper.syncActivity(AddonModQuizProvider.COMPONENT, quiz.id, siteId),
        );

        // Get all the offline attempts for the quiz. It should always be 0 or 1 attempt
        const offlineAttempts = await AddonModQuizOffline.getQuizAttempts(quiz.id, siteId);
        const offlineAttempt = offlineAttempts.pop();

        if (!offlineAttempt) {
            // Nothing to sync, finish.
            return this.finishSync(siteId, quiz, courseId, warnings);
        }

        if (!CoreNetwork.isOnline()) {
            // Cannot sync in offline.
            throw new CoreError(Translate.instant('core.cannotconnect'));
        }

        // Now get the list of online attempts to make sure this attempt exists and isn't finished.
        const onlineAttempts = await AddonModQuiz.getUserAttempts(quiz.id, modOptions);

        const lastAttemptId = onlineAttempts.length ? onlineAttempts[onlineAttempts.length - 1].id : undefined;
        const onlineAttempt = onlineAttempts.find((attempt) => attempt.id == offlineAttempt.id);

        if (!onlineAttempt || AddonModQuiz.isAttemptFinished(onlineAttempt.state)) {
            // Attempt not found or it's finished in online. Discard it.
            warnings.push(Translate.instant('addon.mod_quiz.warningattemptfinished'));

            return this.finishSync(siteId, quiz, courseId, warnings, {
                attemptId: offlineAttempt.id,
                offlineAttempt,
                onlineAttempt,
                removeAttempt: true,
            });
        }

        // Get the data stored in offline.
        const answersList = await AddonModQuizOffline.getAttemptAnswers(offlineAttempt.id, siteId);

        if (!answersList.length) {
            // No answers stored, finish.
            return this.finishSync(siteId, quiz, courseId, warnings, {
                attemptId: lastAttemptId,
                offlineAttempt,
                onlineAttempt,
                removeAttempt: true,
            });
        }

        const offlineAnswers = CoreQuestion.convertAnswersArrayToObject(answersList);
        const offlineQuestions = AddonModQuizOffline.classifyAnswersInQuestions(offlineAnswers);

        // We're going to need preflightData, get it.
        const info = await AddonModQuiz.getQuizAccessInformation(quiz.id, modOptions);

        const preflightData = await AddonModQuizPrefetchHandler.getPreflightData(
            quiz,
            info,
            onlineAttempt,
            askPreflight,
            'core.settings.synchronization',
            siteId,
        );

        // Now get the online questions data.
        const onlineQuestions = await AddonModQuiz.getAllQuestionsData(quiz, onlineAttempt, preflightData, {
            pages: AddonModQuiz.getPagesFromLayoutAndQuestions(onlineAttempt.layout || '', offlineQuestions),
            readingStrategy: CoreSitesReadingStrategy.ONLY_NETWORK,
            siteId,
        });

        // Validate questions, discarding the offline answers that can't be synchronized.
        const discardedData = await this.validateQuestions(onlineAttempt.id, onlineQuestions, offlineQuestions, siteId);

        // Let questions prepare the data to send.
        await Promise.all(Object.keys(offlineQuestions).map(async (slotString) => {
            const slot = Number(slotString);
            const onlineQuestion = onlineQuestions[slot];

            await CoreQuestionDelegate.prepareSyncData(
                onlineQuestion,
                offlineQuestions[slot].answers,
                AddonModQuizProvider.COMPONENT,
                quiz.coursemodule,
                siteId,
            );
        }));

        // Get the answers to send.
        const answers = AddonModQuizOffline.extractAnswersFromQuestions(offlineQuestions);
        const finish = !!offlineAttempt.finished && !discardedData;

        if (discardedData) {
            if (offlineAttempt.finished) {
                warnings.push(Translate.instant('addon.mod_quiz.warningdatadiscardedfromfinished'));
            } else {
                warnings.push(Translate.instant('addon.mod_quiz.warningdatadiscarded'));
            }
        }

        // Send the answers.
        await AddonModQuiz.processAttempt(quiz, onlineAttempt, answers, preflightData, finish, false, false, siteId);

        if (!finish) {
            // Answers sent, now set the current page.
            await CoreUtils.ignoreErrors(AddonModQuiz.logViewAttempt(
                onlineAttempt.id,
                offlineAttempt.currentpage,
                preflightData,
                false,
                siteId,
            ));
        }

        // Data sent. Finish the sync.
        return this.finishSync(siteId, quiz, courseId, warnings, {
            attemptId: lastAttemptId,
            offlineAttempt,
            onlineAttempt,
            removeAttempt: true,
            updated: true,
            onlineQuestions,
        });
    }

    /**
     * Validate questions, discarding the offline answers that can't be synchronized.
     *
     * @param attemptId Attempt ID.
     * @param onlineQuestions Online questions
     * @param offlineQuestions Offline questions.
     * @param siteId Site ID. If not defined, current site.
     * @returns Promise resolved with boolean: true if some offline data was discarded, false otherwise.
     */
    async validateQuestions(
        attemptId: number,
        onlineQuestions: Record<number, CoreQuestionQuestionParsed>,
        offlineQuestions: AddonModQuizQuestionsWithAnswers,
        siteId?: string,
    ): Promise<boolean> {
        let discardedData = false;

        await Promise.all(Object.keys(offlineQuestions).map(async (slotString) => {
            const slot = Number(slotString);
            const offlineQuestion = offlineQuestions[slot];
            const onlineQuestion = onlineQuestions[slot];
            const offlineSequenceCheck = <string> offlineQuestion.answers[':sequencecheck'];

            if (onlineQuestion) {
                // We found the online data for the question, validate that the sequence check is ok.
                if (!CoreQuestionDelegate.validateSequenceCheck(onlineQuestion, offlineSequenceCheck)) {
                    // Sequence check is not valid, remove the offline data.
                    await AddonModQuizOffline.removeQuestionAndAnswers(attemptId, slot, siteId);

                    discardedData = true;
                    delete offlineQuestions[slot];
                } else {
                    // Sequence check is valid. Use the online one to prevent synchronization errors.
                    offlineQuestion.answers[':sequencecheck'] = String(onlineQuestion.sequencecheck);
                }
            } else {
                // Online question not found, it can happen for 2 reasons:
                // 1- It's a sequential quiz and the question is in a page already passed.
                // 2- Quiz layout has changed (shouldn't happen since it's blocked if there are attempts).
                await AddonModQuizOffline.removeQuestionAndAnswers(attemptId, slot, siteId);

                discardedData = true;
                delete offlineQuestions[slot];
            }
        }));

        return discardedData;
    }

}

export const AddonModQuizSync = makeSingleton(AddonModQuizSyncProvider);

/**
 * Data returned by a quiz sync.
 */
export type AddonModQuizSyncResult = CoreSyncResult & {
    attemptFinished: boolean; // Whether an attempt was finished in the site due to the sync.
};

/**
 * Options to pass to finish sync.
 */
type FinishSyncOptions = {
    attemptId?: number; // Last attempt ID.
    offlineAttempt?: AddonModQuizAttemptDBRecord; // Offline attempt synchronized, if any.
    onlineAttempt?: AddonModQuizAttemptWSData; // Online data for the offline attempt.
    removeAttempt?: boolean; // Whether the offline data should be removed.
    updated?: boolean; // Whether the offline data should be removed.
    onlineQuestions?: Record<number, CoreQuestionQuestionParsed>; // Online questions indexed by slot.
};

/**
 * Data passed to AUTO_SYNCED event.
 */
export type AddonModQuizAutoSyncData = {
    quizId: number;
    attemptFinished: boolean;
    warnings: string[];
};
