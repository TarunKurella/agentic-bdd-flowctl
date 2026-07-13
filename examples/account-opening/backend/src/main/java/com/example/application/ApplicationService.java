package com.example.application;

public class ApplicationService {
    private final ApplicationRepository applicationRepository;

    public ApplicationService(ApplicationRepository applicationRepository) {
        this.applicationRepository = applicationRepository;
    }

    public ApplicationResponse submit(ApplicationRequest request) {
        Application application = new Application();
        application.setStatus(ApplicationStatus.SUBMITTED);
        Application saved = applicationRepository.save(application);
        return new ApplicationResponse(saved.getId());
    }
}
